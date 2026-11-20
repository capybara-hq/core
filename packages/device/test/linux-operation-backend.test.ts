import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxExecutionRef } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shellQuote } from "../src/exec/shared.js";
import {
  dockerUnavailable,
  type FixtureNetworks,
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
  openAuthorityFor,
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
    expect(support.outsideSandbox).toBe(true);
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
    // a mise-managed tool: its install in the data directory runs; mise's config.toml (which may
    // hold tokens) is never readable
    const miseBin = `${home}/.local/share/mise/installs/tool/1.0/bin`;
    device.run(
      `mkdir -p ${q(miseBin)} ${q(`${home}/.config/mise`)} && printf '#!/bin/sh\necho mise-tool-ran\n' > ${q(`${miseBin}/tool`)} && chmod +x ${q(`${miseBin}/tool`)} && printf 'TOKEN=secret' > ${q(`${home}/.config/mise/config.toml`)}`,
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
          '"$MISE_DATA_DIR/installs/tool/1.0/bin/tool" > got-mise',
          'if [ -n "$MISE_CONFIG_DIR" ]; then printf set; else printf unset; fi > mise-config-env',
          'cat "$H/.config/mise/config.toml" > got-mise-config 2>/dev/null || rm -f got-mise-config',
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
      for (const name of ["wrote-x", "wrote-versions", "got-outside", "got-mise-config"])
        expect(await read(`${root}/${name}`), name).toBeNull();
      expect(text(await read(`${root}/got-mise`)), result.stderr).toBe("mise-tool-ran\n");
      expect(text(await read(`${root}/mise-config-env`))).toBe("unset");
      expect(text(await read(`${home}/.asdf/x`))).toBe("shim");
      expect(text(await read(`${home}/.tool-versions`))).toBe("nodejs 22.12.0");
    } finally {
      device.run(
        `rm -rf ${q(`${home}/.asdf`)} ${q(`${home}/.tool-versions`)} ${q(`${home}/outside.txt`)} ${q(`${home}/.local/share/mise`)} ${q(`${home}/.config/mise`)}`,
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
    // 403, and the loopback the name resolves to is refused before any connect (403)
    device.run("mkdir -m 700 /home/sandbox/state-private");
    const strict = new HostServer(device);
    servers.push(strict);
    const production = await hostBackend(strict, {
      stateDir: "/home/sandbox/state-private",
      deviceId: "device-private",
      privateProxyTargets: false,
    });
    const refused = await ask(production);
    expect(refused.stdout.trim(), refused.stderr).toBe("407 403 403 403");
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
    expect(support.outsideSandbox).toBe(true);
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

/** Asks the operation's proxy for each request line; prints a JSON map of status codes. */
const PROXY_PROBE = String.raw`
import base64, json, os, socket, sys, urllib.parse
proxy = urllib.parse.urlsplit(os.environ["https_proxy"])
auth = "Proxy-Authorization: Basic " + base64.b64encode(
    ("%s:%s" % (proxy.username, proxy.password)).encode()).decode()
bodies = {}
def status(line):
    try:
        s = socket.create_connection((proxy.hostname, proxy.port), 10)
        s.sendall((line + "\r\n" + auth + "\r\n\r\n").encode())
        reply = b""
        while b"\r\n" not in reply:
            chunk = s.recv(256)
            if not chunk:
                break
            reply += chunk
        code = reply.split(b" ")[1].decode()
        if code == "403":
            # a refusal's reason, when it gives one
            s.settimeout(5)
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    break
                reply += chunk
            body = reply.partition(b"\r\n\r\n")[2]
            if body:
                bodies[line] = body.decode()
        s.close()
        return code
    except (OSError, IndexError) as error:
        return "error:%s" % getattr(error, "errno", error)
out = {line: status(line) for line in json.loads(sys.argv[1])}
for line, body in bodies.items():
    out[line + " body"] = body
try:
    socket.create_connection((sys.argv[2], int(sys.argv[3])), 5).close()
    out["direct"] = "ok"
except OSError as error:
    out["direct"] = "denied:%d" % error.errno
print(json.dumps(out))
`;

/** Connects to each address; prints a JSON map of ok / denied:<errno>. */
const CONNECT_PROBE = String.raw`
import json, socket, sys
def attempt(host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect((host, port))
        return "ok"
    except OSError as error:
        return "denied:%s" % error.errno
    finally:
        s.close()
out = {}
for host, port in json.loads(sys.argv[1]):
    out["%s:%d" % (host, port)] = attempt(host, port)
print(json.dumps(out))
`;

/**
 * The command's own loopback listeners: its own connects to them are refused, while a client
 * outside the sandbox reaches them (the port is written to `port`; one connection is accepted).
 */
const OWN_LISTENER = String.raw`
import json, socket, sys
def attempt(host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    s = socket.socket(family, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect((host, port))
        return "ok"
    except OSError as error:
        return "denied:%s" % error.errno
    finally:
        s.close()
out = {}
servers = []
for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
    server = socket.socket(family, socket.SOCK_STREAM)
    server.bind((host, 0))
    server.listen(4)
    servers.append(server)
    out["own " + host] = attempt(host, server.getsockname()[1])
for name, port in json.loads(sys.argv[1]).items():
    out[name] = attempt("127.0.0.1", port)
out["other6"] = attempt("::1", 18082)
# a listener whose reading side was shut down and listened again (the review's vector) is no
# more reachable than any other
server = servers[0]
server.shutdown(socket.SHUT_RD)
try:
    server.listen(4)
except OSError:
    pass
out["relistened"] = attempt("127.0.0.1", server.getsockname()[1])
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.bind(("127.0.0.1", 0))
listener.listen(4)
open("port.tmp", "w").write(str(listener.getsockname()[1]))
import os
os.rename("port.tmp", "port")
listener.settimeout(30)
try:
    peer, _ = listener.accept()
    out["outsideClient"] = peer.recv(4).decode()
except OSError as error:
    out["outsideClient"] = "none:%s" % error
print(json.dumps(out))
`;

// The open public network (approval-only profiles design, "Open network") under the production
// forwarder rules, and the fixed denies around it. The device sits on two internal Docker
// networks, a globally routable subnet standing in for the internet and a private one.
describe.skipIf(unavailable !== null)("Linux host operation backend: open network", () => {
  let device: LinuxDevice;
  let backend: HostBackend;
  let net: FixtureNetworks;
  const servers: HostServer[] = [];
  const signal = () => new AbortController().signal;
  const read = async (path: string) => {
    const value = (await inspect(device, { what: "read", path })) as string | null;
    return value === null ? null : Buffer.from(value, "base64").toString();
  };
  const project = (name: string) => {
    const root = `/workspace/${name}-${Math.random().toString(36).slice(2, 8)}`;
    device.run(`mkdir -p ${root}`);
    return root;
  };
  type Network =
    | { kind: "open-public" }
    | { kind: "allowlist"; hosts: string[] }
    | { kind: "none" };
  const exec = async (
    root: string,
    command: string,
    network: Network = { kind: "open-public" },
  ) => {
    const scope = scopeFor(backend.deviceId, {
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
      network,
    });
    return backend.operation(scope, openAuthorityFor(scope.operationId)).exec({
      command,
      cwd: root,
      timeoutMs: 60_000,
      maxOutputBytes: 1 << 16,
      signal: signal(),
    });
  };
  const python = (program: string, ...args: string[]) =>
    `python3 -c ${shellQuote(program)} ${args.map(shellQuote).join(" ")}`;
  /** Starts a background command (Full: outside the sandbox) and waits for its ready file. */
  const background = async (root: string, command: string, outside: boolean) => {
    const scope = scopeFor(
      backend.deviceId,
      outside
        ? {
            profile: "full-access",
            filesystem: { kind: "device" },
            network: { kind: "environment" },
          }
        : {
            profile: "approve-for-me",
            filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
            network: { kind: "none" },
          },
    );
    await backend.background("start", {
      scope,
      authority: openAuthorityFor(scope.operationId),
      args: {
        command: `cd ${root} && ${command}`,
        cwd: root,
        timeoutMs: 600_000,
        maxOutputBytes: 1024,
        taskId: `task-${scope.operationId}`,
        outputPath: `${root}/out-${scope.operationId}.log`,
        retainUntilMs: Date.now() + 3_600_000,
      },
    });
    while ((await read(`${root}/ready`)) === null)
      await new Promise((resolve) => setImmediate(resolve));
  };

  beforeAll(async () => {
    device = await startLinuxDevice({ networks: true, tmpfs: ["/var/spool"] });
    net = device.networks as FixtureNetworks;
    await installServer(device);
    device.run("mkdir -m 700 /home/sandbox/state");
    const server = new HostServer(device);
    servers.push(server);
    backend = await hostBackend(server, {
      stateDir: "/home/sandbox/state",
      network: "open",
      allowedDomains: [],
      // production forwarder rules: the fixture's local addresses are closed like any other
      privateProxyTargets: false,
      fakeIpDns: net.doh,
      // a write root outside the workspace (the crontab spool's stand-in)
      restrictedProjectReach: "os-user",
    });
  });
  afterAll(() => {
    for (const s of servers) s.close();
    device?.remove();
  });

  it("reports the open public network as enforced", async () => {
    expect((await backend.support()).network).toEqual({
      openPublic: true,
      allowlist: true,
      perOperationHosts: true,
    });
  });

  it("reaches public addresses through its proxy on any port; every closed class is refused", async () => {
    const root = project("open");
    const receipts = async () =>
      Promise.all(["ungranted4", "ungranted6"].map((n) => read(`/opt/capybara-receipts/${n}`)));
    const before = await receipts();
    // a service on this device's own (public-class) interface address, outside the sandbox
    await background(
      root,
      `printf r > ready; exec python3 -m http.server 18083 --bind ${net.self}`,
      true,
    );
    const s = net.server;
    const connect = (target: string) => `CONNECT ${target} HTTP/1.1`;
    const open = [
      connect(`public.permission.test:${net.port}`),
      `GET http://public.permission.test:${net.port}/ HTTP/1.1`,
      connect(`${s.public}:${net.port}`),
    ];
    const closed = [
      connect(`private.permission.test:${net.port}`),
      connect(`${s.private}:${net.port}`),
      connect(`[::ffff:${s.private}]:${net.port}`),
      connect(`mapped.permission.test:${net.port}`),
      connect(`nat64.permission.test:${net.port}`),
      connect(`[64:ff9b::${s.private}]:${net.port}`),
      connect("metadata.permission.test:80"),
      connect("169.254.169.254:80"),
      connect("[::ffff:169.254.169.254]:80"),
      connect("azure.permission.test:80"),
      connect("168.63.129.16:80"),
      connect("cgnat.permission.test:80"),
      connect("100.64.0.1:80"),
      connect("192.0.2.1:80"),
      connect("loop.permission.test:18081"),
      connect("localhost:18081"),
      connect("127.0.0.1:18081"),
      connect("[::1]:18082"),
      connect("0.0.0.0:18081"),
      connect("self.permission.test:18083"),
      connect(`${net.self}:18083`),
      `GET http://${s.private}:${net.port}/ HTTP/1.1`,
    ];
    const result = await exec(
      root,
      python(PROXY_PROBE, JSON.stringify([...open, ...closed]), s.public, String(net.port)),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const statuses = JSON.parse(result.stdout) as Record<string, string>;
    expect(Object.fromEntries(open.map((line) => [line, statuses[line]]))).toEqual(
      Object.fromEntries(open.map((line) => [line, "200"])),
    );
    // refused by the forwarder before any connect (403), never a failed dial (502)
    expect(Object.fromEntries(closed.map((line) => [line, statuses[line]]))).toEqual(
      Object.fromEntries(closed.map((line) => [line, "403"])),
    );
    // only the proxy dials: the command's own connect to a public address is refused
    expect(statuses.direct).toBe("denied:13");
    expect(net.accepted("public")).toBe(3);
    expect(net.accepted("private")).toBe(0);
    // the device's own loopback services saw no connection (only the fixture's readiness probe)
    expect(await receipts()).toEqual(before);
  });

  it("an allowlist grant still reaches exactly its names, on web ports, at public addresses", async () => {
    const root = project("allow");
    const lines = [
      "GET http://allowed.permission.test/ HTTP/1.1",
      "CONNECT allowed.permission.test:80 HTTP/1.1",
      "CONNECT public.permission.test:80 HTTP/1.1",
      `CONNECT allowed.permission.test:${net.port} HTTP/1.1`,
      "GET http://private.permission.test/ HTTP/1.1",
      `CONNECT ${net.server.public}:80 HTTP/1.1`,
    ];
    const result = await exec(
      root,
      python(PROXY_PROBE, JSON.stringify(lines), net.server.public, "80"),
      { kind: "allowlist", hosts: ["allowed.permission.test", "private.permission.test"] },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      [lines[0] as string]: "200",
      [lines[1] as string]: "200",
      [lines[2] as string]: "403",
      [lines[3] as string]: "403",
      [lines[4] as string]: "403",
      [lines[5] as string]: "403",
      direct: "denied:13",
    });
    expect(net.accepted("public80")).toBe(2);
  });

  it("never connects to a loopback listener, its own included; clients outside reach its own", async () => {
    const root = project("listen");
    const before = await read("/opt/capybara-receipts/ungranted4");
    // another process outside the sandbox (a TCP service such as a Docker daemon on 2375) and
    // another restricted operation, both listening on loopback
    await background(
      root,
      `${python(
        "import socket\nfor port in (2375, 18084):\n    s = socket.socket(); s.bind(('127.0.0.1', port)); s.listen(8); globals()['k%d' % port] = s\nopen('ready', 'w').close()\nimport time\ntime.sleep(1000)",
      )}`,
      true,
    );
    const otherRoot = project("listen-other");
    await background(
      otherRoot,
      python(
        "import socket, time\ns = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(8)\nopen('port', 'w').write(str(s.getsockname()[1]))\nopen('ready', 'w').close()\ntime.sleep(1000)",
      ),
      false,
    );
    const otherPort = Number(await read(`${otherRoot}/port`));
    const running = exec(
      root,
      python(
        OWN_LISTENER,
        JSON.stringify({ outside: 2375, outside2: 18084, otherOperation: otherPort, root4: 18081 }),
      ),
      { kind: "none" },
    );
    // a client outside the sandbox (Full access) reaches the command's listener
    while ((await read(`${root}/port`)) === null)
      await new Promise((resolve) => setImmediate(resolve));
    const port = Number(await read(`${root}/port`));
    const client = scopeFor(backend.deviceId, {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    });
    await backend.operation(client, openAuthorityFor(client.operationId)).exec({
      command: python(
        "import socket, sys\ns = socket.create_connection(('127.0.0.1', int(sys.argv[1])), 10)\ns.sendall(b'from')\ns.close()",
        String(port),
      ),
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal: signal(),
    });
    const result = await running;
    expect(result.exitCode, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout) as Record<string, string>;
    expect(out.outsideClient).toBe("from");
    for (const key of [
      "own 127.0.0.1",
      "own ::1",
      "outside",
      "outside2",
      "otherOperation",
      "root4",
      "other6",
      "relistened",
    ])
      expect(out[key], key).toMatch(/^denied:/);
    expect(await read("/opt/capybara-receipts/ungranted4")).toBe(before);
    // the same holds in open mode
    const open = await exec(
      root,
      python(
        CONNECT_PROBE,
        JSON.stringify([
          ["127.0.0.1", 2375],
          ["127.0.0.1", otherPort],
        ]),
      ),
    );
    expect(Object.values(JSON.parse(open.stdout))).toEqual([
      expect.stringMatching(/^denied:/),
      expect.stringMatching(/^denied:/),
    ]);
  });

  it("the review's listener probes: no foreign listener is ever reached", async () => {
    const root = project("probes");
    const shut = await exec(
      root,
      python(readFileSync(new URL("./fixtures/linux-probe-shut2.py", import.meta.url), "utf8")),
      { kind: "none" },
    );
    // every run fails at its first connect: no "hits" line, the foreign listener X gets nothing
    expect(shut.stdout, shut.stderr).not.toMatch(/hits|'X'|\{/);
    expect(shut.stdout.trim().split("\n")).toHaveLength(4);
    for (const line of shut.stdout.trim().split("\n")) expect(line).toMatch(/\[Errno \d+\]/);
    const reuse = await exec(
      root,
      python(readFileSync(new URL("./fixtures/linux-probe-reuseport.py", import.meta.url), "utf8")),
      { kind: "none" },
    );
    // SO_REUSEPORT is refused before any group exists
    expect(reuse.exitCode).not.toBe(0);
    expect(reuse.stderr).toMatch(/PermissionError: \[Errno 1\]/);
  });

  it("never joins a foreign service's SO_REUSEPORT group", async () => {
    const root = project("reuseport");
    // a service outside the sandbox in a reuseport group on loopback, counting its connections
    await background(
      root,
      python(
        "import socket, threading, time\ns = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)\ns.bind(('127.0.0.1', 18085)); s.listen(64)\nopen('ready', 'w').close()\nn = 0\nwhile True:\n    s.accept()[0].close(); n += 1\n    open('count.tmp', 'w').write(str(n))\n    import os; os.rename('count.tmp', 'count')",
      ),
      true,
    );
    const attacker = String.raw`
import ctypes, json, socket, struct
out = {}
def attempt(name, action):
    try:
        action()
        out[name] = "ok"
    except OSError as error:
        out[name] = "denied:%d" % error.errno
s = socket.socket()
attempt("reuseport", lambda: s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1))
# a classic BPF program (return 0) as SO_ATTACH_REUSEPORT_CBPF
program = struct.pack("HBBI", 0x06, 0, 0, 0)
buffer = ctypes.create_string_buffer(program)
fprog = struct.pack("HxxxxxxQ", 1, ctypes.addressof(buffer))
attempt("cbpf", lambda: s.setsockopt(socket.SOL_SOCKET, 51, fprog))
attempt("ebpf", lambda: s.setsockopt(socket.SOL_SOCKET, 52, struct.pack("i", 3)))
attempt("bind", lambda: s.bind(("127.0.0.1", 18085)))
print(json.dumps(out))
`;
    const result = await exec(root, python(attacker), { kind: "none" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      reuseport: "denied:1",
      cbpf: "denied:1",
      ebpf: "denied:1",
      bind: "denied:98",
    });
    // the service still gets every connection made to it from outside
    const client = scopeFor(backend.deviceId, {
      profile: "full-access",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    });
    await backend.operation(client, openAuthorityFor(client.operationId)).exec({
      command: python(
        "import socket\nfor _ in range(20):\n    socket.create_connection(('127.0.0.1', 18085), 5).close()",
      ),
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      signal: signal(),
    });
    while (Number(await read(`${root}/count`)) < 20)
      await new Promise((resolve) => setImmediate(resolve));
    expect(Number(await read(`${root}/count`))).toBe(20);
  });

  it("refuses the Docker socket and any UNIX socket outside its roots", async () => {
    const root = project("docker-sock");
    const daemon = project("daemon");
    await background(
      daemon,
      python(
        "import socket, time\ns = socket.socket(socket.AF_UNIX); s.bind('docker.sock'); s.listen(8)\nopen('ready', 'w').close()\ntime.sleep(1000)",
      ),
      true,
    );
    const probe = String.raw`
import json, socket, sys
out = {}
for path in sys.argv[1:]:
    s = socket.socket(socket.AF_UNIX)
    try:
        s.connect(path)
        out[path] = "ok"
    except OSError as error:
        out[path] = "denied:%d" % error.errno
print(json.dumps(out))
`;
    const result = await exec(
      root,
      python(
        probe,
        `${daemon}/docker.sock`,
        "/var/run/docker.sock",
        "/run/containerd/containerd.sock",
      ),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    for (const value of Object.values(JSON.parse(result.stdout) as Record<string, string>))
      expect(value).toMatch(/^denied:/);
  });

  it("refuses links and moves that would redirect a protected path, and the system spools", async () => {
    const root = project("links");
    const script = [
      "ln -s /tmp .claude 2>/dev/null && echo claude-link",
      "ln -s /tmp .config 2>/dev/null && echo config-link",
      "ln -s /tmp Library 2>/dev/null && echo library-link",
      "ln -s /tmp notes && echo notes-link",
      "mkdir -p d/commands && touch d/commands/x.md",
      "mv d .claude 2>/dev/null && echo moved-prepared",
      "mkdir e && touch e/readme && mv e .claude && echo moved-plain",
      "mkdir /var/spool/cron 2>/dev/null && echo cron",
      "mkdir /var/spool/at 2>/dev/null && echo at",
      "mkdir -p /var/spool/stage/crontabs && mv /var/spool/stage /var/spool/cron 2>/dev/null && echo cron-move",
      "mkdir /var/spool/mail && printf m > /var/spool/mail/x && echo mail",
      "true",
    ].join("; ");
    const scope = scopeFor(backend.deviceId, {
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [], writeRoots: [root, "/var/spool"] },
      network: { kind: "none" },
    });
    const result = await backend.operation(scope, openAuthorityFor(scope.operationId)).exec({
      command: script,
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
      signal: signal(),
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["notes-link", "moved-plain", "mail"]);
    expect(await read(`${root}/.claude/readme`)).toBe("");
    expect(await read(`${root}/d/commands/x.md`)).toBe("");
  });

  it("denies writes at a protected home location's resolved target (a dotfile manager's links)", async () => {
    const home = device.run(`node -e "process.stdout.write(require('os').homedir())"`).trim();
    const dotfiles = project("dotfiles");
    device.run(
      `mkdir -p ${dotfiles}/config && printf rc > ${dotfiles}/bashrc && ln -s ${dotfiles}/config ${home}/.config && ln -s ${dotfiles}/bashrc ${home}/.bashrc`,
    );
    try {
      const result = await exec(
        dotfiles,
        [
          "mkdir -p config/systemd/user 2>/dev/null && echo systemd",
          "mkdir -p config/autostart 2>/dev/null && echo autostart",
          "(printf x >> bashrc) 2>/dev/null && echo bashrc",
          "printf ok > config/app.conf && echo app",
          "true",
        ].join("; "),
        { kind: "none" },
      );
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("app");
      expect(await read(`${dotfiles}/bashrc`)).toBe("rc");
    } finally {
      device.run(`rm -f ${home}/.config ${home}/.bashrc`);
    }
  });

  it("a dotfile link's target cannot be moved away, and a dangling link is still followed", async () => {
    const home = device.run(`node -e "process.stdout.write(require('os').homedir())"`).trim();
    const root = project("dangling");
    device.run(`mkdir -p ${root}/dotfiles/config && ln -s ${root}/dotfiles/config ${home}/.config`);
    try {
      // call 1: moving the target's ancestor away (an anchored deny's ancestor) is refused
      const first = await exec(root, "mv dotfiles gone 2>/dev/null && echo moved; true", {
        kind: "none",
      });
      expect(first.stdout.trim(), first.stderr).toBe("");
      // the move done outside the sandbox: the link dangles, and call 2 still denies its target
      device.run(`mv ${root}/dotfiles ${root}/gone`);
      const second = await exec(
        root,
        "mkdir -p dotfiles/config/systemd/user 2>/dev/null && echo systemd; mkdir -p dotfiles/config/app && echo app; true",
        { kind: "none" },
      );
      expect(second.stdout.trim(), second.stderr).toBe("app");
    } finally {
      device.run(`rm -f ${home}/.config`);
    }
  });

  it("every link of a dotfile chain is denied: a middle link cannot be retargeted", async () => {
    const home = device.run(`node -e "process.stdout.write(require('os').homedir())"`).trim();
    const root = project("chain");
    device.run(
      `mkdir -p ${root}/v1 ${root}/v2 && printf rc > ${root}/v1/zshrc && printf rc > ${root}/v2/zshrc && ln -s v1 ${root}/current && ln -s ${root}/current/zshrc ${home}/.zshrc`,
    );
    try {
      const first = await exec(
        root,
        [
          "ln -sfn v2 current 2>/dev/null && echo retargeted",
          "mv current c2 2>/dev/null && echo moved",
          "rm current 2>/dev/null && echo removed",
          "(printf x >> v1/zshrc) 2>/dev/null && echo wrote",
          "true",
        ].join("; "),
        { kind: "none" },
      );
      expect(first.stdout.trim(), first.stderr).toBe("");
      // retargeted outside the sandbox: the next operation denies the new target
      device.run(`ln -sfn v2 ${root}/current`);
      const second = await exec(root, "(printf x >> v2/zshrc) 2>/dev/null && echo wrote; true", {
        kind: "none",
      });
      expect(second.stdout.trim(), second.stderr).toBe("");
      expect(await read(`${root}/v1/zshrc`)).toBe("rc");
      expect(await read(`${root}/v2/zshrc`)).toBe("rc");
    } finally {
      device.run(`rm -f ${home}/.zshrc`);
    }
  });

  it("a directory move into a guarded prefix is atomic against the operation's own writes", async () => {
    const root = project("race");
    // one thread moves d to .claude and back while another adds and removes d/commands and a
    // third watches for .claude/commands: the move's check, rename and recheck exclude the writes
    const race = String.raw`
import os, threading, time
stop = time.monotonic() + 6
seen = [0]
moves = [0]
def mover():
    while time.monotonic() < stop:
        os.makedirs("d", exist_ok=True)
        try:
            os.rename("d", ".claude")
            moves[0] += 1
            os.rename(".claude", "d")
        except OSError:
            pass
def writer():
    while time.monotonic() < stop:
        try:
            os.mkdir("d/commands")
            os.rmdir("d/commands")
        except OSError:
            pass
def sighted():
    # a path lookup is not atomic against renames: ".claude/commands" can resolve .claude to d's
    # directory just before it moves back to d and then find a commands made there. Count only a
    # commands seen inside the directory while it is named .claude before and after the look.
    try:
        fd = os.open(".claude", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return False
    try:
        named = lambda: os.readlink("/proc/self/fd/%d" % fd) == os.path.abspath(".claude")
        before = named()
        try:
            found = os.path.isdir(os.path.join("/proc/self/fd/%d" % fd, "commands"))
        except OSError:
            found = False
        return before and found and named()
    finally:
        os.close(fd)
def watcher():
    while time.monotonic() < stop:
        if sighted():
            seen[0] += 1
threads = [threading.Thread(target=f) for f in (mover, writer, watcher)]
for t in threads:
    t.start()
for t in threads:
    t.join()
print(seen[0], moves[0])
`;
    const result = await exec(root, python(race), { kind: "none" });
    expect(result.exitCode, result.stderr).toBe(0);
    const [seen, moves] = result.stdout.trim().split(" ").map(Number);
    expect(moves).toBeGreaterThan(0);
    expect(seen).toBe(0);
  });

  it("a directory move into a guarded prefix is checked in a staging name no other operation can write", async () => {
    const root = project("race2");
    // operation A moves d to .claude and back; operation B, sharing the write root, adds and
    // removes d/commands, recreates d, and watches for .claude/commands
    const mover = String.raw`
import os, time
stop = time.monotonic() + 6
moves = 0
while time.monotonic() < stop:
    os.makedirs("d", exist_ok=True)
    try:
        os.rename("d", ".claude")
        moves += 1
        os.rename(".claude", "d")
    except OSError:
        pass
print(moves)
`;
    const writer = String.raw`
import os, threading, time
stop = time.monotonic() + 6
seen = [0]
def write():
    while time.monotonic() < stop:
        for action in (lambda: os.mkdir("d/commands"), lambda: os.rmdir("d/commands"),
                       lambda: os.mkdir("d")):
            try:
                action()
            except OSError:
                pass
def sighted():
    # a path lookup is not atomic against renames: ".claude/commands" can resolve .claude to d's
    # directory just before it moves back to d and then find a commands made there. Count only a
    # commands seen inside the directory while it is named .claude before and after the look.
    try:
        fd = os.open(".claude", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return False
    try:
        named = lambda: os.readlink("/proc/self/fd/%d" % fd) == os.path.abspath(".claude")
        before = named()
        try:
            found = os.path.isdir(os.path.join("/proc/self/fd/%d" % fd, "commands"))
        except OSError:
            found = False
        return before and found and named()
    finally:
        os.close(fd)
def watch():
    while time.monotonic() < stop:
        if sighted():
            seen[0] += 1
threads = [threading.Thread(target=write), threading.Thread(target=watch)]
for t in threads:
    t.start()
for t in threads:
    t.join()
print(seen[0])
`;
    const [a, b] = await Promise.allSettled([
      exec(root, python(mover), { kind: "none" }),
      exec(root, python(writer), { kind: "none" }),
    ]);
    // A either finishes, or (B took d while A's prepared directory sat in staging, so it could
    // not go back) ends with its directory in quarantine: never at the guarded place
    if (a.status === "fulfilled") {
      expect(a.value.exitCode, a.value.stderr).toBe(0);
      expect(Number(a.value.stdout.trim())).toBeGreaterThan(0);
    } else expect(String(a.reason)).toMatch(/ended the operation.*quarantine/);
    expect(b.status).toBe("fulfilled");
    if (b.status !== "fulfilled") return;
    expect(b.value.exitCode, b.value.stderr).toBe(0);
    expect(Number(b.value.stdout.trim())).toBe(0);
    expect(await read(`${root}/.claude/commands`)).toBeNull();
    expect(
      device.run(`test -d ${root}/.claude/commands && echo present || echo absent`).trim(),
    ).toBe("absent");
  });

  it("a guarded move that cannot be finished nor undone is quarantined and ends the operation", async () => {
    device.run("mkdir -m 700 /home/sandbox/state-fault");
    const faulty = new HostServer(device);
    servers.push(faulty);
    const failing = await hostBackend(faulty, {
      stateDir: "/home/sandbox/state-fault",
      deviceId: "device-fault",
      network: "open",
      allowedDomains: [],
      privateProxyTargets: false,
      restrictedProjectReach: "os-user",
      // test seam: the final rename and the move back both fail
      faultInjection: { stagedMove: "fail" },
    });
    const root = project("fault");
    const scope = scopeFor(failing.deviceId, {
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
      network: { kind: "none" },
    });
    await expect(
      failing.operation(scope, openAuthorityFor(scope.operationId)).exec({
        command: "mkdir -p d/x && mv d .claude; sleep 30",
        cwd: root,
        timeoutMs: 60_000,
        maxOutputBytes: 4096,
        signal: signal(),
      }),
    ).rejects.toThrow(/ended the operation.*quarantine/);
    const listing = device.run(`ls -a ${root}`).split("\n");
    expect(listing).not.toContain(".claude");
    expect(listing).not.toContain("d");
    const quarantined = listing.filter((name) => name.startsWith(".capybara-staging-quarantine-"));
    expect(quarantined).toHaveLength(1);
    expect(device.run(`ls ${root}/${quarantined[0]}`).trim()).toBe("x");
  });

  describe("a write checked against a parent descriptor that moves before its effect", () => {
    let pausing: HostBackend;
    // the seam's marker, created by the broker in the parent once the check passed
    const marker = ".capybara-test-paused";

    beforeAll(async () => {
      device.run("mkdir -m 700 /home/sandbox/state-pause");
      const paused = new HostServer(device);
      servers.push(paused);
      pausing = await hostBackend(paused, {
        stateDir: "/home/sandbox/state-pause",
        deviceId: "device-pause",
        network: "open",
        allowedDomains: [],
        privateProxyTargets: false,
        restrictedProjectReach: "os-user",
        // test seam: a mkdir of "commands" pauses after its check, before the mkdir
        faultInjection: { pauseBeforeMkdir: "commands" },
      });
    });
    const run = (root: string, command: string) => {
      const scope = scopeFor(pausing.deviceId, {
        profile: "approve-for-me",
        filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
        network: { kind: "none" },
      });
      return pausing.operation(scope, openAuthorityFor(scope.operationId)).exec({
        command,
        cwd: root,
        timeoutMs: 60_000,
        maxOutputBytes: 4096,
        signal: signal(),
      });
    };
    /** A native write of the same operation kind (Write / Edit), refused or not. */
    const nativeWrite = (root: string, path: string) => {
      const scope = scopeFor(pausing.deviceId, {
        profile: "approve-for-me",
        filesystem: { kind: "scoped", readRoots: [], writeRoots: [root] },
        network: { kind: "none" },
      });
      return pausing
        .operation(scope, openAuthorityFor(scope.operationId))
        .writeFile(path, new TextEncoder().encode("note"), signal())
        .then(
          () => "written",
          (error: Error) => `refused: ${error.name}: ${error.message}`,
        );
    };
    /**
     * Starts a write that creates d/commands in its own operation (`mkdir d/commands` through the
     * broker by default) and waits until it is paused between its check and its mkdir.
     */
    const pausedWrite = async <T = Awaited<ReturnType<typeof run>>>(
      root: string,
      start?: () => Promise<T>,
    ) => {
      device.run(`mkdir ${root}/d`);
      const writer = (start ? start() : run(root, "mkdir d/commands 2>&1; echo $?")) as Promise<T>;
      let settled = false;
      void writer.finally(() => {
        settled = true;
      });
      while ((await read(`${root}/d/${marker}`)) === null) {
        if (settled)
          throw new Error(`the write ended before it paused: ${JSON.stringify(await writer)}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      // wrapped: an async function returning the promise itself would wait for it
      return { writer };
    };

    it("another operation's guarded move waits for the write it checked (the device files lock)", async () => {
      const root = project("held");
      const { writer } = await pausedWrite(root);
      // operation A moves d to .claude while B holds d's descriptor between check and mkdir
      const mover = await run(root, "mv d .claude 2>&1; echo $?");
      const written = await writer;
      expect(written.stdout.trim()).toBe("0");
      // A waited for B's write, then found commands in staging and refused the move
      expect(mover.stdout).toMatch(/Permission denied\n1\n?$/);
      expect(device.run(`ls -A ${root}`).trim()).toBe("d");
      expect(device.run(`ls -A ${root}/d`).trim().split("\n").sort()).toEqual([marker, "commands"]);
    });

    it("a create that lands at a protected path through a move outside the sandbox is undone and refused", async () => {
      const root = project("outside");
      const { writer } = await pausedWrite(root);
      // a process outside every sandbox takes no files lock
      device.run(`mv ${root}/d ${root}/.claude`);
      const written = await writer;
      expect(written.stdout).toMatch(/Permission denied\n1\n?$/);
      expect(
        device.run(`test -e ${root}/.claude/commands && echo present || echo absent`).trim(),
      ).toBe("absent");
      expect(device.run(`ls -A ${root}/.claude`).trim()).toBe(marker);
    });

    it("another operation's guarded move waits for a native write it checked (the device files lock)", async () => {
      const root = project("native-held");
      const { writer } = await pausedWrite(root, () =>
        nativeWrite(root, `${root}/d/commands/note.md`),
      );
      const mover = await run(root, "mv d .claude 2>&1; echo $?");
      const outcome = await writer;
      // the move waited for the write, then found commands in staging: refused
      expect(outcome).toBe("written");
      expect(mover.stdout).toMatch(/Permission denied\n1\n?$/);
      // the device user's own file (0600)
      expect(device.run(`cat ${root}/d/commands/note.md`)).toBe("note");
      expect(device.run(`ls -A ${root}`).trim()).toBe("d");
    });

    it("a native write whose parent moves to a protected path outside the sandbox is undone and refused", async () => {
      const root = project("native-outside");
      const { writer } = await pausedWrite(root, () =>
        nativeWrite(root, `${root}/d/commands/note.md`),
      );
      device.run(`mv ${root}/d ${root}/.claude`);
      expect(await writer).toMatch(/^refused: SandboxScopeDeniedError/);
      expect(
        device.run(`test -e ${root}/.claude/commands && echo present || echo absent`).trim(),
      ).toBe("absent");
      expect(device.run(`ls -A ${root}/.claude`).trim()).toBe(marker);
    });
  });

  it("the device's files lock is out of every sandbox's reach", async () => {
    const lock = "/home/sandbox/state/operation-files.lock";
    const root = project("lock");
    // the agent created it at the first restricted launch
    await exec(root, "true", { kind: "none" });
    expect(device.run(`test -f ${lock} && echo file`).trim()).toBe("file");
    // neither its path nor a descriptor any process holds on it opens from inside
    const probe = String.raw`
import json, os, sys
lock = sys.argv[1]
result = {"direct": None, "found": 0, "reopened": 0}
try:
    os.close(os.open(lock, os.O_RDONLY))
    result["direct"] = "opened"
except OSError as error:
    result["direct"] = error.errno
for pid in filter(str.isdigit, os.listdir("/proc")):
    try:
        fds = os.listdir("/proc/%s/fd" % pid)
    except OSError:
        continue
    for fd in fds:
        path = "/proc/%s/fd/%s" % (pid, fd)
        try:
            if os.readlink(path) != lock:
                continue
        except OSError:
            continue
        result["found"] += 1
        try:
            os.close(os.open(path, os.O_RDONLY))
            result["reopened"] += 1
        except OSError:
            pass
print(json.dumps(result))
`;
    const result = await exec(root, python(probe, lock), { kind: "none" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ direct: 13, found: 0, reopened: 0 });
    // a grant that would make it readable is refused before anything runs
    const scope = scopeFor(backend.deviceId, {
      profile: "approve-for-me",
      filesystem: { kind: "scoped", readRoots: ["/home/sandbox/state"], writeRoots: [root] },
      network: { kind: "none" },
    });
    await expect(
      backend.operation(scope, openAuthorityFor(scope.operationId)).exec({
        command: `cat ${lock}`,
        cwd: root,
        timeoutMs: 10_000,
        maxOutputBytes: 100,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ name: "SandboxScopeDeniedError" });
  });

  it("a guarded move waits a bounded time for the operation's other writes (EBUSY)", async () => {
    const root = project("busy");
    // a FIFO open without a reader holds the broker's shared files lock
    const started = Date.now();
    const result = await exec(
      root,
      "mkfifo f && (printf x > f &) && sleep 0.3 && mkdir d && (mv d .claude 2>&1 || true); true",
      { kind: "none" },
    );
    expect(result.stdout).toMatch(/Device or resource busy/);
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(device.run(`test -d ${root}/d && echo d`).trim()).toBe("d");
  });

  it("re-resolves a fake-IP resolver's answers through encrypted DNS and checks the real address", async () => {
    const root = project("fake-ip");
    const before = { public: net.accepted("public"), public80: net.accepted("public80") };
    const lines = [
      `CONNECT fake.permission.test:${net.port} HTTP/1.1`,
      `GET http://fake.permission.test:${net.port}/ HTTP/1.1`,
      `CONNECT fakepriv.permission.test:${net.port} HTTP/1.1`,
      `CONNECT fakedown.permission.test:${net.port} HTTP/1.1`,
      // a fake-IP literal is only a reserved address
      `CONNECT 198.18.0.10:${net.port} HTTP/1.1`,
    ];
    const open = await exec(
      root,
      python(PROXY_PROBE, JSON.stringify(lines), net.server.public, String(net.port)),
    );
    expect(open.exitCode, open.stderr).toBe(0);
    const statuses = JSON.parse(open.stdout) as Record<string, string>;
    expect(lines.map((line) => statuses[line])).toEqual(["200", "200", "403", "403", "403"]);
    // the refusal after a failed DoH names the fake-IP resolver; a private real address is a
    // plain refusal
    expect(statuses[`${lines[3]} body`]).toMatch(/fake-IP resolver/);
    expect(statuses[`${lines[2]} body`]).toBeUndefined();
    expect(net.accepted("public") - before.public).toBe(2);
    expect(net.accepted("private")).toBe(0);
    // a granted name the resolver answers with a fake IP takes the same path
    const allow = await exec(
      root,
      python(
        PROXY_PROBE,
        JSON.stringify([
          "GET http://fakeallow.permission.test/ HTTP/1.1",
          "GET http://fakepriv.permission.test/ HTTP/1.1",
        ]),
        net.server.public,
        "80",
      ),
      { kind: "allowlist", hosts: ["fakeallow.permission.test", "fakepriv.permission.test"] },
    );
    expect(allow.exitCode, allow.stderr).toBe(0);
    expect(JSON.parse(allow.stdout)).toMatchObject({
      "GET http://fakeallow.permission.test/ HTTP/1.1": "200",
      "GET http://fakepriv.permission.test/ HTTP/1.1": "403",
    });
    expect(net.accepted("public80") - before.public80).toBe(1);
  });
});
