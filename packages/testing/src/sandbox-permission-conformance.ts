import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  type ExecResult,
  isSandboxPermissionUnsupportedError,
  isSandboxScopeDeniedError,
  type PermissionProfile,
  type SandboxFileScope,
  type SandboxNetworkScope,
  type SandboxOperation,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import type { NativeFixtureEntry } from "./sandbox-native-conformance.js";

/** A controlled endpoint whose receipts the fixture counts out of band (never via the device). */
export interface SandboxPermissionEndpoint {
  /** A numeric address the device can reach directly. */
  readonly host: string;
  readonly port: number;
  /** Accepted connections so far, observed by the endpoint itself. */
  receipts(): Promise<number>;
}

/** The scope one fresh operation receives; the fixture adds the IDs and revisions. */
export interface SandboxPermissionGrant {
  readonly profile: PermissionProfile;
  readonly filesystem: SandboxFileScope;
  readonly network: SandboxNetworkScope;
}

/**
 * The actual provider under test, on one shared device. All paths are absolute device paths on one
 * shared filesystem; `root` and `sibling` are empty directories owned by the device user. The
 * device must provide `/bin/sh`, `python3`, `node` and `curl`. Inspection is trusted, out of band
 * and read-only; it never runs through a restricted operation and never grants anything.
 */
export interface SandboxPermissionFixture {
  /** The project root granted (writable) to restricted operations. */
  readonly root: string;
  /** A directory outside every restricted grant, on the same filesystem. */
  readonly sibling: string;
  /** Existing files the device user may write ordinarily but no restricted grant covers. */
  readonly protectedPaths: readonly string[];
  /** `granted` is reachable by allowlisting its host; `ungranted` never is. */
  readonly endpoints: {
    readonly granted: SandboxPermissionEndpoint;
    readonly ungranted: readonly SandboxPermissionEndpoint[];
  };
  /** The provider's own runtime report; the harness never infers support from a fixture. */
  support(): Promise<SandboxPermissionSupport>;
  /** A fresh operation (new operation ID) for the grant, through the provider's factory. */
  operation(grant: SandboxPermissionGrant): Promise<SandboxOperation>;
  /** Trusted setup under root or sibling; preserves entries from earlier calls. */
  seed(entries: readonly NativeFixtureEntry[]): Promise<void>;
  inspect: {
    readFile(path: string): Promise<Uint8Array | null>;
    /** Permission bits (`st_mode & 0o7777`), or null when missing. */
    mode(path: string): Promise<number | null>;
    /** The subset of `pids` still running on the device. */
    alive(pids: readonly number[]): Promise<number[]>;
  };
  /** Removes fixture-owned resources, including after an assertion failure. */
  dispose(): Promise<void>;
}

const text = (data: Uint8Array | null) => (data === null ? null : Buffer.from(data).toString());
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** A Python program in which one thread rewrites a syscall's pointer argument mid-call. */
const FLIP_PROGRAM = String.raw`
import ctypes, socket, struct, sys, threading
libc = ctypes.CDLL(None, use_errno=True)
mode, rounds = sys.argv[1], int(sys.argv[2])
stop = threading.Event()
def flipper(buffer, good, bad):
    while not stop.is_set():
        ctypes.memmove(buffer, bad, len(bad))
        ctypes.memmove(buffer, good, len(good))
ok = 0
if mode == "connect":
    def sockaddr(host, port):
        return struct.pack("HH4s8x", socket.AF_INET, socket.htons(port), socket.inet_aton(host))
    good = sockaddr(sys.argv[3], int(sys.argv[4]))
    bad = sockaddr(sys.argv[5], int(sys.argv[6]))
    buffer = ctypes.create_string_buffer(good, len(good))
    thread = threading.Thread(target=flipper, args=(buffer, good, bad))
    thread.start()
    for _ in range(rounds):
        fd = libc.socket(socket.AF_INET, socket.SOCK_STREAM, 0)
        if fd >= 0 and libc.connect(fd, buffer, len(good)) == 0:
            ok += 1
        if fd >= 0:
            libc.close(fd)
else:
    good, bad = sys.argv[3].encode() + b"\0", sys.argv[4].encode() + b"\0"
    size = max(len(good), len(bad))
    good, bad = good.ljust(size, b"\0"), bad.ljust(size, b"\0")
    buffer = ctypes.create_string_buffer(good, size)
    thread = threading.Thread(target=flipper, args=(buffer, good, bad))
    thread.start()
    for index in range(rounds):
        if libc.chmod(buffer, 0o640 if index % 2 else 0o600) == 0:
            ok += 1
stop.set()
thread.join()
print("ok=%d" % ok)
`;

/** Atomically exchanges a directory with a symlink to an outside path until a stop file exists. */
const SWAP_PROGRAM = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
base, outside, stop = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(base + "/dir")
os.symlink(outside, base + "/link")
open(base + "/swapping", "w").close()
swaps = 0
while not os.path.exists(stop):
    if libc.renameat2(-100, (base + "/dir").encode(), -100, (base + "/link").encode(), 2) == 0:
        swaps += 1
print("swaps=%d" % swaps)
`;

/**
 * Proves an actual provider's permission boundary on one shared device: positive controls, sibling,
 * symlink, protected-path and network denials, Full controls without restricted filters, both
 * overlap orders, component/root swaps and mutable syscall pointers during access, exact
 * cancellation and fresh narrowed scopes. A provider that reports restricted unsupported must
 * refuse restricted operations (fail closed); nothing here substitutes a fixture flag for support.
 */
export async function runSandboxPermissionConformance(
  fixture: SandboxPermissionFixture,
): Promise<void> {
  const { root, sibling } = fixture;
  const at = (base: string, name: string) => posix.join(base, name);
  const secret = `sibling-secret-${randomUUID()}`;
  const scoped = (writeRoots: string[]): SandboxFileScope => ({
    kind: "scoped",
    readRoots: [],
    writeRoots,
  });
  const restricted = (
    network: SandboxNetworkScope = { kind: "none" },
    writeRoots = [root],
  ): SandboxPermissionGrant => ({
    profile: "approve-for-me",
    filesystem: scoped(writeRoots),
    network,
  });
  const full: SandboxPermissionGrant = {
    profile: "full-access",
    filesystem: { kind: "device" },
    network: { kind: "environment" },
  };
  const { granted, ungranted } = fixture.endpoints;
  const allowlisted: SandboxNetworkScope = { kind: "allowlist", hosts: [granted.host] };
  const exec = async (
    grant: SandboxPermissionGrant,
    command: string,
    signal = new AbortController().signal,
    timeoutMs = 120_000,
  ): Promise<ExecResult> =>
    (await fixture.operation(grant)).exec({
      command,
      cwd: root,
      timeoutMs,
      maxOutputBytes: 1 << 20,
      signal,
    });
  const native = async (grant: SandboxPermissionGrant) => {
    const operation = await fixture.operation(grant);
    assert(operation.list && operation.scan, "Permission conformance requires list and scan");
    return operation as Required<SandboxOperation>;
  };
  const signal = new AbortController().signal;
  const denied = async (promise: Promise<unknown>, what: string) => {
    await assert.rejects(promise, (error) => isSandboxScopeDeniedError(error), what);
  };
  const waitFor = async (path: string) => {
    while ((await fixture.inspect.readFile(path)) === null) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const receipts = async () =>
    Promise.all([granted, ...ungranted].map((endpoint) => endpoint.receipts()));
  const connect = (endpoint: SandboxPermissionEndpoint) =>
    `python3 -c ${quote(
      `import socket; socket.create_connection((${JSON.stringify(endpoint.host)}, ${endpoint.port}), 10).close()`,
    )}`;

  try {
    const support = await fixture.support();
    if (support.restricted === null) {
      // Fail closed: no restricted operation may run, and nothing falls back to Full access.
      await assert.rejects(
        (async () =>
          (await fixture.operation(restricted())).exec({
            command: "true",
            cwd: root,
            timeoutMs: 10_000,
            maxOutputBytes: 1024,
            signal,
          }))(),
        (error) => isSandboxPermissionUnsupportedError(error),
        "an unsupported runtime must refuse restricted operations",
      );
      return;
    }
    assert.deepEqual(
      support.restricted,
      { filesystem: true, network: true, native: true, concurrentScopes: true },
      "restricted support requires all four claims together",
    );

    await fixture.seed([
      { path: at(sibling, "secret"), kind: "file", data: new TextEncoder().encode(secret) },
      { path: at(root, "inroot.txt"), kind: "file", data: new TextEncoder().encode("inroot") },
      { path: at(root, "escape"), kind: "symlink", target: at(sibling, "secret") },
      { path: at(root, "linked"), kind: "symlink", target: sibling },
    ]);
    const siblingMode = await fixture.inspect.mode(at(sibling, "secret"));
    const siblingIntact = async (label: string) => {
      assert.equal(text(await fixture.inspect.readFile(at(sibling, "secret"))), secret, label);
      assert.equal(await fixture.inspect.mode(at(sibling, "secret")), siblingMode, label);
    };

    // Positive controls: ordinary shell, Python, Node and native work inside the root.
    const shell = await exec(
      restricted(),
      "cat inroot.txt && printf shell > shell.txt && mkdir -p d/e && printf x > d/e/f && " +
        "chmod 755 d/e/f && touch -d 2001-01-01 d/e/f && ln -s shell.txt alias && cat alias",
    );
    assert.equal(shell.exitCode, 0, `restricted shell work must succeed: ${shell.stderr}`);
    assert.equal(shell.stdout, "inrootshell");
    assert.equal(await fixture.inspect.mode(at(root, "d/e/f")), 0o755, "chmod inside the root");
    const python = await exec(
      restricted(),
      `python3 -c ${quote("import pathlib; p = pathlib.Path('py.txt'); p.write_text('py'); print(p.read_text())")}`,
    );
    assert.equal(python.exitCode, 0, `restricted Python work must succeed: ${python.stderr}`);
    assert.equal(python.stdout.trim(), "py");
    const node = await exec(
      restricted(),
      `node -e ${quote("const fs = require('fs'); fs.writeFileSync('node.txt', 'node'); console.log(fs.readFileSync('node.txt', 'utf8'))")}`,
    );
    assert.equal(node.exitCode, 0, `restricted Node work must succeed: ${node.stderr}`);
    assert.equal(node.stdout.trim(), "node");
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await (await native(restricted())).writeFile(at(root, "native/n.bin"), bytes, signal);
    assert.deepEqual(
      await (await native(restricted())).readFile(at(root, "native/n.bin"), {
        maxBytes: 10,
        signal,
      }),
      { data: bytes, truncated: false },
    );
    assert.deepEqual(await (await native(restricted())).stat(at(root, "native/n.bin"), signal), {
      size: 4,
      isDir: false,
    });
    assert.deepEqual(
      await (await native(restricted())).list(at(root, "native"), {
        limit: 10,
        signal,
      }),
      { entries: [{ name: "n.bin", isDir: false }], truncated: false },
    );

    // Negative controls: sibling, symlink escapes and protected paths stay out of reach.
    const reads = await exec(
      restricted(),
      `cat ${quote(at(sibling, "secret"))}; cat escape; cat linked/secret; true`,
    );
    assert(!reads.stdout.includes(secret), "restricted reads must not reach the sibling");
    await exec(
      restricted(),
      `printf pwn > ${quote(at(sibling, "w1"))}; printf pwn > linked/w2; printf pwn > escape; ` +
        `chmod 777 ${quote(at(sibling, "secret"))}; chmod 777 escape; ` +
        `touch -d 2001-01-01 ${quote(at(sibling, "secret"))}; true`,
    );
    assert.equal(await fixture.inspect.readFile(at(sibling, "w1")), null, "sibling write");
    assert.equal(await fixture.inspect.readFile(at(sibling, "w2")), null, "symlinked dir write");
    await siblingIntact("restricted writes and chmod must not change the sibling");
    for (const path of fixture.protectedPaths) {
      const before = text(await fixture.inspect.readFile(path));
      await exec(restricted(), `printf pwn >> ${quote(path)}; true`);
      assert.equal(text(await fixture.inspect.readFile(path)), before, `protected ${path}`);
    }
    await denied(
      (await native(restricted())).readFile(at(sibling, "secret"), { maxBytes: 100, signal }),
      "native sibling read",
    );
    await denied(
      (await native(restricted())).readFile(at(root, "escape"), { maxBytes: 100, signal }),
      "native symlink escape read",
    );
    await denied(
      (await native(restricted())).writeFile(at(sibling, "n1"), bytes, signal),
      "native sibling write",
    );
    await denied(
      (await native(restricted())).writeFile(at(root, "linked/n2"), bytes, signal),
      "native write through a directory symlink",
    );
    await denied((await native(restricted())).stat(at(sibling, "secret"), signal), "stat");
    await denied((await native(restricted())).list(sibling, { limit: 5, signal }), "list");
    await siblingIntact("native denials must leave the sibling unchanged");

    // Network: only the granted endpoint, and only while allowlisted.
    const base = await receipts();
    for (const command of [
      connect(granted),
      `curl -fsS -m 10 -o /dev/null http://${granted.host}:${granted.port}/`,
      `node -e ${quote(`require("net").connect(${granted.port}, ${JSON.stringify(granted.host)}).on("connect", function () { this.end() })`)}`,
    ]) {
      const result = await exec(restricted(allowlisted), command);
      assert.equal(result.exitCode, 0, `granted endpoint must work: ${command}: ${result.stderr}`);
    }
    for (const endpoint of ungranted) {
      const result = await exec(restricted(allowlisted), connect(endpoint));
      assert.notEqual(result.exitCode, 0, `ungranted ${endpoint.host}:${endpoint.port}`);
    }
    const none = await exec(restricted(), connect(granted));
    assert.notEqual(none.exitCode, 0, "network none must refuse even the granted endpoint");
    const after = await receipts();
    assert.equal(after[0], (base[0] ?? 0) + 3, "granted endpoint receipts");
    assert.deepEqual(after.slice(1), base.slice(1), "ungranted endpoints must see no connection");

    // Full access controls on the same device: no restricted filters apply.
    if (support.fullAccess) {
      const control = await exec(
        full,
        `cat ${quote(at(sibling, "secret"))} && printf full > ${quote(at(sibling, "full"))} && ${connect(ungranted[0] ?? granted)}`,
      );
      assert.equal(control.exitCode, 0, `Full access control must succeed: ${control.stderr}`);
      assert(control.stdout.includes(secret), "Full access reads the sibling");
      assert.equal(text(await fixture.inspect.readFile(at(sibling, "full"))), "full");
      assert.equal(
        (await receipts())[1],
        (after[1] ?? 0) + 1,
        "Full reaches an ungranted endpoint",
      );
    }

    // Both overlap orders: a live Full operation never widens a restricted one, and vice versa.
    if (support.fullAccess) {
      const first = exec(
        restricted(),
        `printf r > ready-a; until [ -e barrier-a ]; do sleep 0.01; done; ` +
          `printf pwn > ${quote(at(sibling, "overlap-a"))}; cat ${quote(at(sibling, "secret"))}; true`,
      );
      await waitFor(at(root, "ready-a"));
      await exec(full, `printf full > ${quote(at(sibling, "full-a"))} && touch barrier-a`);
      assert(!(await first).stdout.includes(secret), "restricted after a live Full operation");
      assert.equal(await fixture.inspect.readFile(at(sibling, "overlap-a")), null);
      const fullFirst = exec(
        full,
        `printf r > ready-b; until [ -e barrier-b ]; do sleep 0.01; done; ` +
          `printf full > ${quote(at(sibling, "full-b"))}`,
      );
      await waitFor(at(root, "ready-b"));
      const second = await exec(
        restricted(),
        `printf pwn > ${quote(at(sibling, "overlap-b"))}; cat ${quote(at(sibling, "secret"))}; touch barrier-b`,
      );
      assert(!second.stdout.includes(secret), "restricted while a Full operation is live");
      assert.equal((await fullFirst).exitCode, 0);
      assert.equal(await fixture.inspect.readFile(at(sibling, "overlap-b")), null);
      assert.equal(text(await fixture.inspect.readFile(at(sibling, "full-b"))), "full");
    }

    // Component swaps during native and shell access never escape.
    if (support.fullAccess) {
      const race = at(root, "race");
      const swapper = exec(
        full,
        `python3 -c ${quote(SWAP_PROGRAM)} ${quote(race)} ${quote(sibling)} ${quote(at(root, "race-stop"))}`,
      );
      await waitFor(at(race, "swapping"));
      for (let index = 0; index < 30; index++) {
        const op = await native(restricted());
        try {
          await op.writeFile(at(race, `dir/n-${index}`), bytes, signal);
        } catch {}
        const read = await (await native(restricted()))
          .readFile(at(race, "dir/secret"), { maxBytes: 200, signal })
          .catch(() => null);
        assert.notEqual(read && text(read.data), secret, "native read escaped during a swap");
      }
      const shellRace = await exec(
        restricted(),
        `i=0; while [ $i -lt 400 ]; do printf pwn > race/dir/x-$i; cat race/dir/secret; ` +
          `chmod 777 race/dir/secret; i=$((i+1)); done 2>/dev/null; true`,
      );
      assert(!shellRace.stdout.includes(secret), "shell read escaped during a swap");
      await exec(full, "touch race-stop");
      assert.equal((await swapper).exitCode, 0);
      for (let index = 0; index < 400; index++) {
        assert.equal(await fixture.inspect.readFile(at(sibling, `x-${index}`)), null);
        if (index < 30)
          assert.equal(await fixture.inspect.readFile(at(sibling, `n-${index}`)), null);
      }
      await siblingIntact("component swaps must not reach the sibling");

      // A swap of the root path itself during a live operation, then a fresh operation.
      const moved = `${root}.moved-${randomUUID()}`;
      const live = exec(
        restricted(),
        `printf r > ready-root; until [ -e ${quote(at(moved, "barrier-root"))} ]; do sleep 0.01; done; ` +
          `printf pwn > ${quote(at(root, "after-swap"))}; cat ${quote(at(root, "secret"))}; printf ok > in-place; true`,
      );
      await waitFor(at(root, "ready-root"));
      await exec(
        full,
        `mv ${quote(root)} ${quote(moved)} && ln -s ${quote(sibling)} ${quote(root)} && touch ${quote(at(moved, "barrier-root"))}`,
      );
      const swapped = await live;
      assert(!swapped.stdout.includes(secret), "a live operation must not follow a root swap");
      assert.equal(text(await fixture.inspect.readFile(at(moved, "in-place"))), "ok");
      await denied(
        (async () => (await native(restricted())).writeFile(at(root, "fresh"), bytes, signal))(),
        "a fresh native operation must reject a swapped root",
      );
      const fresh = await (await fixture.operation(restricted()))
        .exec({
          command: "printf pwn > fresh-exec",
          cwd: root,
          timeoutMs: 30_000,
          maxOutputBytes: 1024,
          signal,
        })
        .catch((error: unknown) => error);
      assert(
        isSandboxScopeDeniedError(fresh) || (fresh as ExecResult).exitCode !== 0,
        "a fresh exec must not run in a swapped root",
      );
      await exec(full, `rm ${quote(root)} && mv ${quote(moved)} ${quote(root)}`);
      for (const name of ["after-swap", "fresh", "fresh-exec"]) {
        assert.equal(await fixture.inspect.readFile(at(sibling, name)), null, `root swap ${name}`);
      }
      await siblingIntact("root swaps must not reach the sibling");
    }

    // A mutable syscall pointer: another thread rewrites the address/path during the check.
    const target = ungranted[0];
    if (target) {
      const before = await receipts();
      const flip = await exec(
        restricted(allowlisted),
        `python3 -c ${quote(FLIP_PROGRAM)} connect 1500 ${granted.host} ${granted.port} ${target.host} ${target.port}`,
      );
      assert.equal(flip.exitCode, 0, `pointer race program must run: ${flip.stderr}`);
      const flipped = await receipts();
      assert.deepEqual(flipped.slice(1), before.slice(1), "a flipped sockaddr must not escape");
      assert((flipped[0] ?? 0) > (before[0] ?? 0), "the race must also reach the granted endpoint");
      const chmods = await exec(
        restricted(),
        `python3 -c ${quote(FLIP_PROGRAM)} chmod 3000 ${quote(at(root, "inroot.txt"))} ${quote(at(sibling, "secret"))}`,
      );
      assert.equal(chmods.exitCode, 0, `chmod race program must run: ${chmods.stderr}`);
      assert.notEqual(chmods.stdout.trim(), "ok=0", "in-root chmods must succeed");
      await siblingIntact("a flipped path must not chmod the sibling");
    }

    // Exact cancellation: detached descendants end; a sibling operation keeps running.
    const keepAlive = exec(
      restricted(),
      `printf r > ready-keep; until [ -e release-keep ]; do sleep 0.01; done; printf done > kept`,
    );
    await waitFor(at(root, "ready-keep"));
    const abort = new AbortController();
    const cancelled = exec(
      restricted(),
      `(sleep 1000 & echo $! > p1); nohup sh -c 'sleep 1001' > /dev/null 2>&1 & echo $! > p2; ` +
        `setsid sleep 1002 > /dev/null 2>&1 & ` +
        `python3 -c ${quote("import os, time\nif os.fork() == 0:\n    os.setpgid(0, 0)\n    open('p3.tmp', 'w').write(str(os.getpid()))\n    os.rename('p3.tmp', 'p3')\n    time.sleep(1003)")} & ` +
        `until [ -e p3 ]; do sleep 0.01; done; printf r > ready-cancel; sleep 1004`,
      abort.signal,
    );
    await waitFor(at(root, "ready-cancel"));
    const pids = await Promise.all(
      ["p1", "p2", "p3"].map(async (name) =>
        Number(text(await fixture.inspect.readFile(at(root, name)))),
      ),
    );
    assert.deepEqual(await fixture.inspect.alive(pids), pids, "descendants run before cancel");
    abort.abort();
    const stopped = await cancelled;
    assert.equal(stopped.exitCode, null, "a cancelled operation has no exit code");
    assert.deepEqual(await fixture.inspect.alive(pids), [], "cancellation ends every descendant");
    await exec(restricted(), "touch release-keep");
    assert.equal((await keepAlive).exitCode, 0, "the sibling operation survives the cancel");
    assert.equal(text(await fixture.inspect.readFile(at(root, "kept"))), "done");

    // Timeout ends the whole owned tree as well.
    const timed = await exec(restricted(), `(sleep 1005 & echo $! > p4); sleep 1006`, signal, 1000);
    assert.equal(timed.timedOut, true, "a restricted timeout is reported");
    const p4 = Number(text(await fixture.inspect.readFile(at(root, "p4"))));
    assert.deepEqual(await fixture.inspect.alive([p4]), [], "timeout ends background children");

    // A fresh narrowed scope (after revocation) is enforced on the very next operation, while an
    // operation that started with the broader grant keeps it.
    await fixture.seed([{ path: at(root, "narrow/keep"), kind: "directory" }]);
    const narrowed = restricted({ kind: "none" }, [at(root, "narrow/keep")]);
    const broad = exec(
      restricted(),
      `printf r > ready-broad; until [ -e narrow/keep/release-broad ]; do sleep 0.01; done; ` +
        `printf broad > broad.txt`,
    );
    await waitFor(at(root, "ready-broad"));
    const overlapping = await (await fixture.operation(narrowed)).exec({
      command: `printf pwn > ${quote(at(root, "overlapping.txt"))}; touch release-broad; true`,
      cwd: at(root, "narrow/keep"),
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal,
    });
    assert.equal(overlapping.exitCode, 0);
    assert.equal((await broad).exitCode, 0, "the broader live grant is retained");
    assert.equal(text(await fixture.inspect.readFile(at(root, "broad.txt"))), "broad");
    assert.equal(
      await fixture.inspect.readFile(at(root, "overlapping.txt")),
      null,
      "a concurrent narrower scope stays narrow",
    );
    const narrow = await (await fixture.operation(narrowed)).exec({
      command: `printf ok > keep.txt; printf pwn > ${quote(at(root, "revoked.txt"))}; true`,
      cwd: at(root, "narrow/keep"),
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal,
    });
    assert.equal(narrow.exitCode, 0);
    assert.equal(text(await fixture.inspect.readFile(at(root, "narrow/keep/keep.txt"))), "ok");
    assert.equal(await fixture.inspect.readFile(at(root, "revoked.txt")), null, "revoked root");
    await denied(
      (await native(narrowed)).writeFile(at(root, "revoked-native"), bytes, signal),
      "native write after narrowing",
    );
  } finally {
    await fixture.dispose();
  }
}
