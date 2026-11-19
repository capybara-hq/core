import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxExecutionRef } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shellQuote } from "../src/exec/shared.js";
import {
  dockerUnavailable,
  inspect,
  type LinuxDevice,
  NAMES,
  scopeFor,
  startLinuxDevice,
} from "./linux-docker-fixture.js";
import {
  authorityFor,
  type HostBackend,
  HostServer,
  hostBackend,
  installServer,
} from "./linux-host-fixture.js";

const unavailable = dockerUnavailable();
const required = process.env.CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED === "1";

describe.runIf(required && unavailable !== null)("Linux restricted runtime is required", () => {
  it("has Docker and the sandbox image", () => {
    throw new Error(`CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1 but: ${unavailable}`);
  });
});

const text = (data: Uint8Array | null) => (data === null ? null : Buffer.from(data).toString());

// The Linux operation backend as a Linux host runs it: the device process (a bundled server) and
// its agents are ordinary processes of the device user in a hardened container. The full
// permission conformance against it (and the local-Docker backend) runs in
// packages/testing/test/device-linux-backend.test.ts, beside the harness.
describe.skipIf(unavailable !== null)("Linux host operation backend", () => {
  let device: LinuxDevice;
  let server: HostServer;
  let backend: HostBackend;
  const servers: HostServer[] = [];

  const read = async (path: string) => {
    const value = (await inspect(device, { what: "read", path })) as string | null;
    return value === null ? null : new Uint8Array(Buffer.from(value, "base64"));
  };
  const alive = async (pids: number[]) =>
    (await inspect(device, { what: "alive", pids })) as number[];
  const pidsOf = async (root: string, names: string[]) =>
    Promise.all(names.map(async (name) => Number(text(await read(`${root}/${name}`)))));
  /** A fresh project root for one test. */
  const project = (name: string) => {
    const root = `/workspace/${name}-${Math.random().toString(36).slice(2, 8)}`;
    device.run(`mkdir -p ${root}`);
    return root;
  };
  const restricted = (root: string) =>
    scopeFor(backend.deviceId, {
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
      network: { kind: "none" },
    });
  const full = () =>
    scopeFor(backend.deviceId, {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    });
  const until = async (check: () => Promise<boolean>) => {
    while (!(await check())) await new Promise((resolve) => setImmediate(resolve));
  };
  /** Waits for a file, failing at once if `pending` (the operation) settles first without it. */
  const exists = async (path: string, pending?: Promise<unknown>) => {
    let ended: unknown;
    let settled = false;
    pending?.then(
      (value) => {
        settled = true;
        ended = value;
      },
      (error: unknown) => {
        settled = true;
        ended = error;
      },
    );
    await until(async () => {
      if ((await read(path)) !== null) return true;
      if (settled && (await read(path)) === null)
        throw new Error(`the operation ended before ${path} existed: ${String(ended)}`);
      return false;
    });
  };

  beforeAll(async () => {
    device = await startLinuxDevice();
    await installServer(device);
    device.run("mkdir -m 700 /home/sandbox/state");
    server = new HostServer(device);
    servers.push(server);
    backend = await hostBackend(server, { stateDir: "/home/sandbox/state" });
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    device?.remove();
  });

  it("selects the Linux backend on Linux: restricted from the launcher's probe, Full, background", async () => {
    const support = await backend.support();
    if (required) expect(support.restricted).not.toBeNull();
    expect(support.fullAccess).toBe(true);
    expect(support.background).toBe(true);
  });

  it("runs background work: status, tail, readOutput, then an exact stop of its whole tree", async () => {
    const root = project("bg");
    const scope = restricted(root);
    const ref = (await backend.background("start", {
      scope,
      authority: authorityFor(scope.operationId),
      args: {
        command: `(sleep 1000 & echo $! > p1); echo first; echo second >&2; printf r > ready; sleep 1001`,
        cwd: root,
        timeoutMs: 600_000,
        maxOutputBytes: 1 << 20,
        taskId: "task-bg",
        outputPath: `${root}/out.log`,
        retainUntilMs: Date.now() + 3_600_000,
      },
    })) as {
      executionId: string;
      operationId: string;
      instanceId: string;
      instanceGeneration: string;
    };
    await exists(`${root}/ready`);
    expect(await backend.background("status", { ref })).toEqual({ state: "running" });
    await until(async () => {
      const tail = (await backend.background("tail", { ref, args: { maxBytes: 100 } })) as {
        data: Uint8Array;
      };
      return text(tail.data) === "first\nsecond\n";
    });
    const output = (await backend.background("readOutput", {
      ref,
      args: { offset: 0, maxBytes: 100 },
    })) as { data: Uint8Array; nextOffset: number };
    expect(text(output.data)).toBe("first\nsecond\n");
    const [p1] = await pidsOf(root, ["p1"]);
    expect(await alive([p1 as number])).toEqual([p1]);
    expect(await backend.background("stop", { ref, args: { graceMs: 0 } })).toEqual({
      outcome: "stopped",
    });
    expect(await alive([p1 as number])).toEqual([]);
    // retained: the reference still answers after the work ended
    expect(await backend.background("status", { ref })).toMatchObject({ state: "exited" });
    expect(await backend.background("stop", { ref, args: { graceMs: 0 } })).toEqual({
      outcome: "stopped",
    });
    expect(
      text(
        (
          (await backend.background("readOutput", { ref, args: { offset: 6, maxBytes: 100 } })) as {
            data: Uint8Array;
          }
        ).data,
      ),
    ).toBe("second\n");
  });

  it("stops one Full background task exactly while a sibling keeps running", async () => {
    const root = project("full");
    const start = async (name: string) => {
      const scope = full();
      return (await backend.background("start", {
        scope,
        authority: authorityFor(scope.operationId),
        args: {
          command: `cd ${root} && (sleep 1000 & echo $! > ${name}-child); printf r > ${name}-ready; sleep 1001`,
          timeoutMs: 600_000,
          maxOutputBytes: 1024,
          taskId: `task-${name}`,
          outputPath: `${root}/${name}.log`,
          retainUntilMs: Date.now() + 3_600_000,
        },
      })) as SandboxExecutionRef;
    };
    const a = await start("a");
    const b = await start("b");
    await exists(`${root}/a-ready`);
    await exists(`${root}/b-ready`);
    const [childA, childB] = (await pidsOf(root, ["a-child", "b-child"])) as [number, number];
    expect(await backend.background("stop", { ref: a, args: { graceMs: 50 } })).toEqual({
      outcome: "stopped",
    });
    expect(await alive([childA, childB])).toEqual([childB]);
    expect(await backend.background("status", { ref: b })).toEqual({ state: "running" });
    expect(await backend.background("stop", { ref: b, args: { graceMs: 0 } })).toEqual({
      outcome: "stopped",
    });
    expect(await alive([childB])).toEqual([]);
  });

  it("an aborted foreground exec ends its command tree (restricted and Full)", async () => {
    const root = project("abort");
    for (const [label, scope] of [
      ["r", restricted(root)],
      ["f", full()],
    ] as const) {
      const abort = new AbortController();
      const running = backend
        .operation(scope, authorityFor(scope.operationId))
        .exec({
          command: `cd ${root} && (sleep 1000 & echo $! > ${label}-child); printf r > ${label}-ready; sleep 1001`,
          cwd: root,
          timeoutMs: 600_000,
          maxOutputBytes: 1024,
          signal: abort.signal,
        })
        .catch((error: unknown) => error);
      await exists(`${root}/${label}-ready`, running);
      const [child] = (await pidsOf(root, [`${label}-child`])) as [number];
      abort.abort();
      await running;
      expect(await alive([child])).toEqual([]);
    }
  });

  // the macOS hang (mac-abort-escape.test.ts) has no Linux equivalent: a descendant that leaves
  // the process group stays in the closed session, so the abort ends it with the session
  it("an aborted restricted exec ends a descendant that left the process group", async () => {
    const root = project("abort-pgid");
    const abort = new AbortController();
    const escaper = [
      "import os, time",
      "pid = os.fork()",
      "if pid == 0:",
      "    os.setpgid(0, 0)",
      "    open('escaped', 'w').write(str(os.getpid()))",
      "    time.sleep(1000)",
      "os.waitpid(pid, 0)",
    ].join("\n");
    const scope = restricted(root);
    const running = backend
      .operation(scope, authorityFor(scope.operationId))
      .exec({
        command: `cd ${root} && (python3 -c ${shellQuote(escaper)} &); until [ -s escaped ]; do sleep 0.01; done; printf r > ready; sleep 1001`,
        cwd: root,
        timeoutMs: 600_000,
        maxOutputBytes: 1024,
        signal: abort.signal,
      })
      .catch((error: unknown) => error);
    await exists(`${root}/ready`, running);
    const [escaped] = (await pidsOf(root, ["escaped"])) as [number];
    abort.abort();
    await running;
    expect(await alive([escaped])).toEqual([]);
  });

  it("a lost agent fails the operation and its recorded session is reaped", async () => {
    const root = project("lost");
    const scope = full();
    const running = backend
      .operation(scope, authorityFor(scope.operationId))
      .exec({
        command: `cd ${root} && (sleep 1000 & echo $! > child); printf r > ready; sleep 1001`,
        cwd: root,
        timeoutMs: 600_000,
        maxOutputBytes: 1024,
        signal: new AbortController().signal,
      })
      .then(
        () => "resolved",
        (error: Error) => error.message,
      );
    await exists(`${root}/ready`, running);
    const [child] = (await pidsOf(root, ["child"])) as [number];
    // the supervisor is lost (as by the OOM killer): SIGKILL the agent, nothing else
    device.run(
      `for p in /proc/[0-9]*; do [ "\${p#/proc/}" = "$$" ] && continue; grep -q "def native_watch" $p/cmdline 2>/dev/null && kill -9 \${p#/proc/}; done; true`,
    );
    expect(await running).toMatch(/agent was lost/);
    expect(await alive([child])).toEqual([]);
  });

  it("a restarted device process reaps the Full session a lost process left behind", async () => {
    device.run("mkdir -m 700 /home/sandbox/state-restart");
    const first = new HostServer(device);
    servers.push(first);
    const before = await hostBackend(first, {
      stateDir: "/home/sandbox/state-restart",
      deviceId: "device-restart",
    });
    const root = project("restart");
    const scope = scopeFor(before.deviceId, {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    });
    await before.background("start", {
      scope,
      authority: authorityFor(scope.operationId),
      args: {
        command: `cd ${root} && (sleep 1000 & echo $! > child); printf r > ready; sleep 1001`,
        timeoutMs: 600_000,
        maxOutputBytes: 1024,
        taskId: "task-restart",
        outputPath: `${root}/out.log`,
        retainUntilMs: Date.now() + 3_600_000,
      },
    });
    await exists(`${root}/ready`);
    const [child] = (await pidsOf(root, ["child"])) as [number];
    // device process and agent die together: nothing is left to end the Full session
    const serverPid = await first.ready;
    device.run(
      `for p in /proc/[0-9]*; do [ "\${p#/proc/}" = "$$" ] && continue; grep -q "def native_watch" $p/cmdline 2>/dev/null && kill -9 \${p#/proc/}; done; kill -9 ${serverPid}`,
    );
    await first.exited;
    expect(await alive([child])).toEqual([child]);
    const second = new HostServer(device);
    servers.push(second);
    await hostBackend(second, {
      stateDir: "/home/sandbox/state-restart",
      deviceId: "device-restart",
    });
    await until(async () => (await alive([child])).length === 0);
  });

  it("a restricted command reads the version manager files of the home, read only, and no more", async () => {
    const root = project("tool-homes");
    // the device process's own home (the image's home of the device user)
    const home = device.run(`node -e "process.stdout.write(require('os').homedir())"`).trim();
    const q = (path: string) => JSON.stringify(path);
    device.run(
      `mkdir -p ${q(`${home}/.asdf`)} && printf shim > ${q(`${home}/.asdf/x`)} && printf 'nodejs 22.12.0' > ${q(`${home}/.tool-versions`)} && printf private > ${q(`${home}/outside.txt`)}`,
    );
    try {
      const scope = restricted(root);
      const result = await backend.operation(scope, authorityFor(scope.operationId)).exec({
        command: [
          `H=${q(home)}`,
          'printf %s "$ASDF_DATA_DIR" > env',
          'cat "$ASDF_DATA_DIR/x" > got-x',
          'cat "$H/.tool-versions" > got-versions',
          '(printf y >> "$H/.asdf/x") 2>/dev/null && printf w > wrote-x',
          '(printf y >> "$H/.tool-versions") 2>/dev/null && printf w > wrote-versions',
          'cat "$H/outside.txt" > got-outside 2>/dev/null || rm -f got-outside',
          "true",
        ].join("; "),
        cwd: root,
        timeoutMs: 20_000,
        maxOutputBytes: 4096,
        signal: new AbortController().signal,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(text(await read(`${root}/env`))).toBe(`${home}/.asdf`);
      expect(text(await read(`${root}/got-x`)), result.stderr).toBe("shim");
      expect(text(await read(`${root}/got-versions`)), result.stderr).toBe("nodejs 22.12.0");
      for (const name of ["wrote-x", "wrote-versions", "got-outside"])
        expect(await read(`${root}/${name}`), name).toBeNull();
      expect(text(await read(`${home}/.asdf/x`))).toBe("shim");
      expect(text(await read(`${home}/.tool-versions`))).toBe("nodejs 22.12.0");
    } finally {
      device.run(
        `rm -rf ${q(`${home}/.asdf`)} ${q(`${home}/.tool-versions`)} ${q(`${home}/outside.txt`)}`,
      );
    }
  });

  it("never reaches an owner-denied path: exec grants around it are refused, native links stop", async () => {
    const root = project("denied");
    device.run(
      `mkdir -p ${root}/secret ${root}/open && printf top > ${root}/secret/key && ln -s ${root}/secret/key ${root}/open/link`,
    );
    device.run(`mkdir -m 700 /home/sandbox/state-denied`);
    const guarded = new HostServer(device);
    servers.push(guarded);
    const denying = await hostBackend(guarded, {
      stateDir: "/home/sandbox/state-denied",
      deviceId: "device-denied",
      deniedReadRoots: [`${root}/secret`],
    });
    const scope = (writeRoots: string[]) =>
      scopeFor(denying.deviceId, {
        profile: "approve-for-me",
        filesystem: { kind: "scoped", readRoots: [], writeRoots },
        network: { kind: "none" },
      });
    const signal = new AbortController().signal;
    // Landlock cannot carve the denied directory out of a granted root: refused, nothing runs
    const around = scope([root]);
    await expect(
      denying.operation(around, authorityFor(around.operationId)).exec({
        command: `cat ${root}/secret/key > ${root}/leaked`,
        cwd: root,
        timeoutMs: 10_000,
        maxOutputBytes: 100,
        signal,
      }),
    ).rejects.toMatchObject({ name: "SandboxScopeDeniedError" });
    expect(await read(`${root}/leaked`)).toBeNull();
    // native work checks every resolved path, link targets included
    const native = scope([root]);
    await expect(
      denying.operation(native).readFile(`${root}/open/link`, { maxBytes: 10, signal }),
    ).rejects.toMatchObject({ name: "SandboxScopeDeniedError" });
    const direct = scope([root]);
    await expect(
      denying.operation(direct).readFile(`${root}/secret/key`, { maxBytes: 10, signal }),
    ).rejects.toMatchObject({ name: "SandboxScopeDeniedError" });
    // a grant beside the denied directory works as usual
    const beside = scope([`${root}/open`]);
    const ok = await denying.operation(beside, authorityFor(beside.operationId)).exec({
      command: "printf ok > here && cat here",
      cwd: `${root}/open`,
      timeoutMs: 10_000,
      maxOutputBytes: 100,
      signal,
    });
    expect(ok).toMatchObject({ exitCode: 0, stdout: "ok" });
  });

  it("the allowlist proxy: its own token, web ports only, globally routable addresses only", async () => {
    const root = project("proxy");
    // a local web server on port 80, which the granted name resolves to (a loopback address)
    const listener = full();
    await backend.background("start", {
      scope: listener,
      authority: authorityFor(listener.operationId),
      args: {
        command: `cd ${root} && exec python3 -m http.server 80 --bind 127.0.0.1`,
        timeoutMs: 600_000,
        maxOutputBytes: 1024,
        taskId: "task-http",
        outputPath: `${root}/http.log`,
        retainUntilMs: Date.now() + 3_600_000,
      },
    });
    // ready (checked from Full access: a restricted command reaches only its proxy)
    const ready = full();
    await backend.operation(ready, authorityFor(ready.operationId)).exec({
      command: `until python3 -c "import socket; socket.create_connection(('127.0.0.1', 80), 1)" 2>/dev/null; do sleep 0.05; done`,
      timeoutMs: 30_000,
      maxOutputBytes: 100,
      signal: new AbortController().signal,
    });
    const probe = String.raw`
import base64, os, socket, sys, time, urllib.parse
proxy = urllib.parse.urlsplit(os.environ["http_proxy"])
def ask(request):
    s = socket.create_connection((proxy.hostname, proxy.port), 10)
    s.sendall(request)
    return s.recv(64).split(b" ")[1].decode()
auth = "Proxy-Authorization: Basic " + base64.b64encode(("%s:%s" % (proxy.username, proxy.password)).encode()).decode()
CRLF = "\r\n"
def get(port, header=""):
    return ask(("GET http://NAME:%d/ HTTP/1.1" % port + CRLF + header + CRLF + CRLF).encode())
print(get(80), ask(("CONNECT NAME:18080 HTTP/1.1" + CRLF + auth + CRLF + CRLF).encode()),
      get(18080, auth), get(80, auth))
`.replaceAll("NAME", NAMES.granted);
    const ask = async (target: HostBackend) => {
      const scope = scopeFor(target.deviceId, {
        profile: "approve-for-me",
        filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
        network: { kind: "allowlist", hosts: [NAMES.granted] },
      });
      return target.operation(scope, authorityFor(scope.operationId)).exec({
        command: `python3 - <<'EOF'\n${probe}\nEOF`,
        cwd: root,
        timeoutMs: 30_000,
        maxOutputBytes: 1000,
        signal: new AbortController().signal,
      });
    };
    // production rules: no token 407, CONNECT to another port 403, plain request to another port
    // 403, and the loopback the name resolves to is refused (502)
    device.run("mkdir -m 700 /home/sandbox/state-private");
    const strict = new HostServer(device);
    servers.push(strict);
    const production = await hostBackend(strict, {
      stateDir: "/home/sandbox/state-private",
      deviceId: "device-private",
      privateProxyTargets: false,
    });
    const refused = await ask(production);
    expect(refused.stdout.trim(), refused.stderr).toBe("407 403 403 502");
    // the fixture seam lifts only the address and port rules: the same target is then reached
    const seamed = await ask(backend);
    expect(seamed.stdout.trim(), seamed.stderr).toBe("407 200 200 200");
  });

  it("a brokered FIFO open waits for its peer without pinning a broker thread", async () => {
    const root = project("fifo");
    const scope = restricted(root);
    const piped = await backend.operation(scope, authorityFor(scope.operationId)).exec({
      command: "mkfifo f && (sleep 0.2; cat f) & sleep 0.05; printf through > f; wait",
      cwd: root,
      timeoutMs: 20_000,
      maxOutputBytes: 100,
      signal: new AbortController().signal,
    });
    expect(piped).toMatchObject({ exitCode: 0, stdout: "through" });
    // no reader ever: the timeout ends the command and the broker gives the open up
    const lonely = restricted(root);
    const stuck = await backend.operation(lonely, authorityFor(lonely.operationId)).exec({
      command: "mkfifo g && printf x > g",
      cwd: root,
      timeoutMs: 1000,
      maxOutputBytes: 100,
      signal: new AbortController().signal,
    });
    expect(stuck.timedOut).toBe(true);
  });

  it("reports restricted unavailable when switched off, and Full still works", async () => {
    device.run("mkdir -m 700 /home/sandbox/state-off");
    const off = new HostServer(device);
    servers.push(off);
    const disabled = await hostBackend(off, {
      stateDir: "/home/sandbox/state-off",
      deviceId: "device-off",
      restrictedSupported: false,
    });
    const support = await disabled.support();
    expect(support.restricted).toBeNull();
    expect(support.unavailableReason).toMatch(/switched off/);
    const root = project("off");
    const r = scopeFor(disabled.deviceId, {
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
      network: { kind: "none" },
    });
    await expect(
      disabled.operation(r, authorityFor(r.operationId)).exec({
        command: "true",
        timeoutMs: 10_000,
        maxOutputBytes: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "SandboxPermissionUnsupportedError" });
    const f = scopeFor(disabled.deviceId, {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    });
    const result = await disabled.operation(f, authorityFor(f.operationId)).exec({
      command: "echo full",
      timeoutMs: 10_000,
      maxOutputBytes: 100,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "full\n" });
  });
});

// Full access where the kernel offers no pidfds (an old kernel, or a seccomp profile that returns
// ENOSYS for pidfd_open and pidfd_send_signal): timeouts and aborts still end the command.
describe.skipIf(unavailable !== null)("Linux host operation backend without pidfds", () => {
  let device: LinuxDevice;
  let backend: HostBackend;
  let dir: string;
  const servers: HostServer[] = [];
  const read = async (path: string) => {
    const value = (await inspect(device, { what: "read", path })) as string | null;
    return value === null ? null : Buffer.from(value, "base64").toString();
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cap-no-pidfd-"));
    const profile = join(dir, "seccomp.json");
    await writeFile(
      profile,
      JSON.stringify({
        defaultAction: "SCMP_ACT_ALLOW",
        syscalls: [
          { names: ["pidfd_open", "pidfd_send_signal"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
        ],
      }),
    );
    device = await startLinuxDevice({ seccompProfile: profile });
    await installServer(device);
    device.run("mkdir -m 700 /home/sandbox/state");
    const server = new HostServer(device);
    servers.push(server);
    backend = await hostBackend(server, { stateDir: "/home/sandbox/state" });
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    device?.remove();
    await rm(dir, { recursive: true, force: true });
  });

  const full = () =>
    scopeFor(backend.deviceId, {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    });

  it("reports restricted unavailable (the launcher needs pidfds) but keeps Full", async () => {
    const support = await backend.support();
    expect(support.restricted).toBeNull();
    expect(support.fullAccess).toBe(true);
  });

  it("a Full timeout ends the command and its session", async () => {
    device.run("mkdir -p /workspace/np");
    const scope = full();
    const started = Date.now();
    const result = await backend.operation(scope, authorityFor(scope.operationId)).exec({
      command: "cd /workspace/np && (sleep 1000 & echo $! > child); sleep 1001",
      timeoutMs: 2000,
      maxOutputBytes: 100,
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(15_000);
    const child = Number(await read("/workspace/np/child"));
    expect(await inspect(device, { what: "alive", pids: [child] })).toEqual([]);
  });

  it("a Full abort ends the command and its session", async () => {
    device.run("mkdir -p /workspace/na");
    const scope = full();
    const abort = new AbortController();
    const running = backend
      .operation(scope, authorityFor(scope.operationId))
      .exec({
        command: "cd /workspace/na && (sleep 1000 & echo $! > child); printf r > ready; sleep 1001",
        timeoutMs: 600_000,
        maxOutputBytes: 100,
        signal: abort.signal,
      })
      .catch((error: unknown) => error);
    while ((await read("/workspace/na/ready")) === null)
      await new Promise((resolve) => setImmediate(resolve));
    const child = Number(await read("/workspace/na/child"));
    abort.abort();
    await running;
    expect(await inspect(device, { what: "alive", pids: [child] })).toEqual([]);
  });
});
