import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSandboxScopeDeniedError, SandboxWorkUnsettledError } from "@capybara-hq/plugin-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  LEGACY_MARGIN_MS,
  type OrphanProcesses,
  type ProcessRow,
} from "../src/exec/mac-orphans.js";
import { MacOperationSupervisor } from "../src/exec/operation-supervisor.js";
import { digest } from "../src/exec/operation-types.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";
import { shellQuote } from "../src/exec/shared.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

// restricted workers launch only from a verified, sealed runtime closure (B-7)
const workspace = { runtimeHash: "", cleanup: async () => {} };
beforeAll(async () => {
  Object.assign(workspace, await sealWorkspaceRuntime());
});
afterAll(async () => {
  await workspace.cleanup();
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const scope = {
  operationId: "op",
  admitBeforeMs: 1000,
  deviceId: "d",
  rootConversationId: "r",
  profileRevision: 0,
  ceilingRevision: "c",
  profile: "full-access" as const,
  actor: { accountId: "a", conversationId: "r" },
  tag: "op",
  filesystem: { kind: "device" as const },
  network: { kind: "environment" as const },
};
const grant = {
  full: true,
  readRoots: ["/"],
  writeRoots: ["/"],
  hosts: [],
  deniedReadRoots: [],
  revision: "v",
};
const result = {
  exitCode: 0 as number | null,
  stdout: "hello",
  stderr: "",
  truncated: false,
  timedOut: false,
};
const signal = new AbortController().signal;
async function fixture(
  denyCancel: boolean | number = false,
  outputBarrier?: (name: string) => Promise<void>,
) {
  const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-"));
  dirs.push(stateDir);
  let now = 1;
  let starts = 0;
  let finish!: (v: typeof result) => void;
  let cancelled = 0;
  let output: (b: Buffer, stream?: "stdout" | "stderr") => void = () => {};
  const supervisor = new MacOperationSupervisor({
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => now,
    ...(outputBarrier ? { outputBarrier } : {}),
    start: async (request: MacWorkerRequest) => {
      starts++;
      output = request.onOutput ?? (() => {});
      await request.beforeLaunch();
      await request.onLaunch({ pid: 123, token: "trusted-child" });
      return {
        ready: Promise.resolve(),
        completion: new Promise<typeof result>((r) => {
          finish = r;
        }),
        cancel: async () => {
          cancelled++;
          if (denyCancel === true || (typeof denyCancel === "number" && cancelled <= denyCancel))
            throw Object.assign(new Error("Owned signal denied"), { code: "EPERM" });
          finish({ ...result, exitCode: null });
        },
      };
    },
  });
  return {
    stateDir,
    supervisor,
    emit: async (bytes: Buffer, stream?: "stdout" | "stderr") => {
      for (let offset = 0; offset < bytes.length; offset += 65536)
        await output(bytes.subarray(offset, offset + 65536), stream);
    },
    setNow: (n: number) => {
      now = n;
    },
    starts: () => starts,
    cancelled: () => cancelled,
    finish: () => finish(result),
  };
}
const request = (stateDir: string) => ({
  managedOutput: { artifactRoot: stateDir, outputPath: join(stateDir, "artifact.out") },
  kind: "exec" as const,
  scope,
  grant,
  args: { command: "echo hello", timeoutMs: 1000, maxOutputBytes: 1000 },
  stateDir,
  pythonPath: "/usr/bin/python3",
  runtimeHash: workspace.runtimeHash,
  beforeLaunch: async () => {},
  onLaunch: async () => {},
});
it("consumes before launch, retains reference on retry, rejects changed input and expires tail", async () => {
  const f = await fixture();
  const req = request(f.stateDir);
  const ref = await f.supervisor.start(req, "hash", 2000, signal);
  expect(f.starts()).toBe(1);
  expect(await f.supervisor.start(req, "hash", 2000, signal)).toEqual(ref);
  await expect(f.supervisor.start(req, "changed", 2000, signal)).rejects.toThrow(/input/);
  f.finish();
  await f.supervisor.settled("op");
  expect(await f.supervisor.status(ref, signal)).toEqual({
    state: "exited",
    exitCode: 0,
    timedOut: false,
  });
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
    outcome: "already-exited",
    exitCode: 0,
    timedOut: false,
  });
  f.setNow(2001);
  expect(await f.supervisor.tail(ref, { maxBytes: 65536, signal })).toEqual({
    unavailable: "expired",
  });
  const journal = (await readdir(f.stateDir)).find((name) => name.startsWith("operation-journal-"));
  expect(await readFile(join(f.stateDir, journal as string), "utf8")).not.toContain(
    '"stdout":"hello"',
  );
});
it("records revoke before start and rejects expired or wrong-generation references", async () => {
  const f = await fixture();
  await f.supervisor.revokeOperation(
    { operationId: scope.operationId, admitBeforeMs: scope.admitBeforeMs },
    signal,
  );
  await expect(f.supervisor.start(request(f.stateDir), "hash", 2000, signal)).rejects.toThrow(
    /revoked/,
  );
  const other = {
    ...request(f.stateDir),
    managedOutput: { artifactRoot: f.stateDir, outputPath: join(f.stateDir, "other.out") },
    scope: { ...scope, operationId: "other" },
  };
  const ref = await f.supervisor.start(other, "other", 2000, signal);
  await expect(
    f.supervisor.status({ ...ref, instanceGeneration: "wrong" }, signal),
  ).rejects.toThrow(/reference/);
  f.finish();
  await f.supervisor.settled("other");
});
it("restart preserves consumed unknown and never replays effects", async () => {
  const f = await fixture();
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  const recovered = new MacOperationSupervisor({
    stateDir: f.stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 1,
    start: async () => {
      throw Error("must not relaunch");
    },
  });
  expect(await recovered.status(ref, signal)).toEqual({ state: "lost" });
  await expect(recovered.execute(request(f.stateDir), "hash", signal)).rejects.toThrow(/unknown/);
  await f.supervisor.stop(ref, { graceMs: 0, signal });
});

it("bounds tails to 65536 bytes and never splits a UTF-8 character", async () => {
  const f = await fixture();
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  await f.emit(Buffer.from(`${"a".repeat(70000)}😀`));
  const tail = await f.supervisor.tail(ref, { maxBytes: 3, signal });
  expect(tail).toEqual({ data: Buffer.alloc(0), truncated: true });
  const all = await f.supervisor.tail(ref, { maxBytes: 65536, signal });
  expect("data" in all && all.data.byteLength).toBe(65536);
  await expect(f.supervisor.tail(ref, { maxBytes: 65537, signal })).rejects.toThrow(/65536/);
  await f.supervisor.stop(ref, { graceMs: 0, signal });
});
it("cancellation wins the terminal stop race and retries preserve its outcome", async () => {
  const f = await fixture();
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
  expect(f.cancelled()).toBe(1);
});
it("expired admission is rejected but retained completed lookup still works after its admission deadline", async () => {
  const f = await fixture();
  f.setNow(1001);
  await expect(f.supervisor.start(request(f.stateDir), "hash", 2000, signal)).rejects.toThrow(
    /expired/,
  );
  expect(f.starts()).toBe(0);
  f.setNow(1);
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  f.finish();
  await f.supervisor.settled("op");
  f.setNow(1001);
  expect(await f.supervisor.start(request(f.stateDir), "hash", 2000, signal)).toEqual(ref);
  expect(f.starts()).toBe(1);
});

it.runIf(process.platform === "darwin")(
  "real registered cancellation preserves a live Full sibling in both start orders",
  async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdir, realpath, writeFile } = await import("node:fs/promises");
    const { createServer } = await import("node:http");
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-owned-supervisor-")));
    dirs.push(root);
    const stateDir = join(root, "state");
    const project = join(root, "project");
    const sibling = join(root, "sibling");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(project);
    await mkdir(sibling);
    await writeFile(join(sibling, "sentinel"), "owned-full");
    const releases = new Map<string, () => void>();
    const received = new Map<string, () => void>();
    const server = createServer(async (req, res) => {
      const path = req.url ?? "";
      const hold = new Promise<void>((r) => {
        releases.set(path, r);
      });
      received.get(path)?.();
      await hold;
      if (!res.destroyed) res.end("done");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing owned endpoint");
    const port = address.port;
    const identities: number[] = [];
    const supervisor = new MacOperationSupervisor({
      stateDir,
      deviceId: "d",
      instanceGeneration: "g",
      start: startMacOperationWorker,
    });
    const refs: import("@capybara-hq/plugin-sdk").SandboxExecutionRef[] = [];
    try {
      for (const order of [
        [true, false],
        [false, true],
      ]) {
        const current = new Map<boolean, import("@capybara-hq/plugin-sdk").SandboxExecutionRef>();
        for (const full of order) {
          const id = `${order[0] ? "full-first" : "restricted-first"}-${full ? "full" : "restricted"}`;
          let arrived!: () => void;
          const arrival = new Promise<void>((r) => {
            arrived = r;
          });
          received.set(`/${id}`, arrived);
          let runtimePid = 0;
          const request: MacWorkerRequest = {
            kind: "exec",
            scope: { ...scope, operationId: id, admitBeforeMs: Date.now() + 30000 },
            grant: {
              full,
              readRoots: full ? ["/"] : [project],
              writeRoots: [],
              hosts: [`127.0.0.1:${port}`],
              deniedReadRoots: full ? [] : [stateDir, sibling],
              revision: "fixture",
            },
            args: {
              command: `/bin/cat '${sibling}/sentinel'; /usr/bin/curl --fail --silent --show-error --max-time 10 --noproxy '${full ? "*" : ""}' http://127.0.0.1:${port}/${id}`,
              cwd: project,
              timeoutMs: 15000,
              maxOutputBytes: 1000,
            },
            stateDir,
            managedOutput: { artifactRoot: stateDir, outputPath: join(stateDir, `${id}.out`) },
            pythonPath: "/usr/bin/python3",
            runtimeHash: workspace.runtimeHash,
            // the fixture listens on loopback, which only the trusted test seam reopens
            allowPrivateProxyTargets: true,
            beforeLaunch: async () => {},
            onLaunch: async (info) => {
              identities.push(info.pid);
              expect(
                Number(
                  execFileSync("/bin/ps", ["-p", String(info.pid), "-o", "ppid="], {
                    encoding: "utf8",
                  }).trim(),
                ),
              ).toBe(runtimePid);
              console.error(
                JSON.stringify({
                  event: "owned-launch",
                  pid: info.pid,
                  ps: execFileSync(
                    "/bin/ps",
                    ["-p", String(info.pid), "-o", "pid=,pgid=,uid=,stat=,comm="],
                    { encoding: "utf8" },
                  ).trim(),
                }),
              );
            },
            onDiagnostic: console.error,
            onRuntimeReady: async (info) => {
              identities.push(info.pid);
              runtimePid = info.pid;
            },
          };
          const ref = await supervisor.start(
            request,
            id,
            Date.now() + 60000,
            AbortSignal.timeout(20000),
          );
          refs.push(ref);
          current.set(full, ref);
          await Promise.race([
            arrival,
            supervisor.settled(id).then(() => {
              throw Error("Owned request exited before endpoint arrival");
            }),
          ]);
        }
        const restricted = current.get(
          false,
        ) as import("@capybara-hq/plugin-sdk").SandboxExecutionRef;
        const full = current.get(true) as import("@capybara-hq/plugin-sdk").SandboxExecutionRef;
        expect(await supervisor.stop(restricted, { graceMs: 0, signal })).toEqual({
          outcome: "stopped",
        });
        expect(await supervisor.status(full, signal)).toEqual({ state: "running" });
        const restrictedTail = await supervisor.tail(restricted, { maxBytes: 65536, signal });
        expect(
          "data" in restrictedTail && Buffer.from(restrictedTail.data).toString(),
        ).not.toContain("owned-full");
        releases.get(`/${full.operationId}`)?.();
        await supervisor.settled(full.operationId);
        expect(await supervisor.status(full, signal)).toEqual({
          state: "exited",
          exitCode: 0,
          timedOut: false,
        });
        const fullTail = await supervisor.tail(full, { maxBytes: 65536, signal });
        expect("data" in fullTail && Buffer.from(fullTail.data).toString()).toContain("owned-full");
        releases.get(`/${restricted.operationId}`)?.();
      }
    } finally {
      for (const release of releases.values()) release();
      await Promise.all(refs.map((ref) => supervisor.stop(ref, { graceMs: 0, signal })));
      await Promise.all(refs.map((ref) => supervisor.settled(ref.operationId)));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
    for (const pid of identities) expect(() => process.kill(pid, 0)).toThrow();
  },
);

it("a denied trusted cancellation remains durable cancel-pending without a false stopped result", async () => {
  const f = await fixture(true);
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
    outcome: "cancel-pending",
  });
  const recovered = new MacOperationSupervisor({
    stateDir: f.stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 1,
  });
  expect(await recovered.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "cancel-pending" });
  f.finish();
  await f.supervisor.settled("op");
});

it.runIf(process.platform === "darwin")(
  "registered workers end acknowledged execution when their owned controller disconnects",
  async () => {
    const { fork } = await import("node:child_process");
    const { mkdir, realpath, writeFile } = await import("node:fs/promises");
    const { createServer } = await import("node:http");
    const { vi } = await import("vitest");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-disconnect-")));
    dirs.push(root);
    const stateDir = join(root, "state");
    const project = join(root, "project");
    await mkdir(stateDir, { mode: 0o700 });
    await mkdir(project);
    let arrive!: () => void;
    const arrived = new Promise<void>((r) => {
      arrive = r;
    });
    let closeRequest!: () => void;
    const requestClosed = new Promise<void>((r) => {
      closeRequest = r;
    });
    const server = createServer((_req, res) => {
      res.once("close", closeRequest);
      arrive();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("Missing owned endpoint");
    const port = address.port;
    const script = join(root, "controller.mjs");
    const workerUrl = new URL("../src/exec/operation-worker.ts", import.meta.url).href;
    const sealUrl = new URL("./runtime-seal.ts", import.meta.url).href;
    const request = {
      kind: "exec",
      scope: { ...scope, operationId: "disconnect", admitBeforeMs: Date.now() + 30000 },
      grant: {
        full: false,
        readRoots: [project],
        writeRoots: [],
        hosts: [`127.0.0.1:${port}`],
        deniedReadRoots: [stateDir],
        revision: "fixture",
      },
      args: {
        command: `/usr/bin/curl --fail --silent --show-error --max-time 10 --noproxy '' http://127.0.0.1:${port}/owned`,
        cwd: project,
        timeoutMs: 15000,
        maxOutputBytes: 1000,
      },
      stateDir,
      pythonPath: "/usr/bin/python3",
      runtimeHash: workspace.runtimeHash,
      // the fixture listens on loopback, which only the trusted test seam reopens
      allowPrivateProxyTargets: true,
    };
    await writeFile(
      script,
      `import {startMacOperationWorker} from ${JSON.stringify(workerUrl)}; import {sealWorkspaceRuntime} from ${JSON.stringify(sealUrl)}; await sealWorkspaceRuntime(${JSON.stringify(root)}); const worker=await startMacOperationWorker({...${JSON.stringify(request)},beforeLaunch:async()=>{},onLaunch:async identity=>process.send({pid:identity.pid}),onRuntimeReady:async identity=>process.send({pid:identity.pid})},new AbortController().signal);await worker.ready;process.send({ready:true});await worker.completion;`,
    );
    const child = fork(script, [], {
      execArgv: ["--import", "tsx", "--conditions=@capybara-hq/source"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const identities: number[] = [];
    let ready!: () => void;
    const acknowledged = new Promise<void>((r) => {
      ready = r;
    });
    child.on("message", (m) => {
      const message = m as { pid?: number; ready?: boolean };
      if (message.pid) identities.push(message.pid);
      if (message.ready) ready();
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
    let diagnostics = "";
    child.stderr?.on("data", (b: Buffer) => {
      diagnostics += b.toString();
    });
    try {
      await Promise.race([
        Promise.all([acknowledged, arrived]),
        exited.then(() => {
          throw Error(`Owned controller exited before acknowledgment: ${diagnostics}`);
        }),
      ]);
      expect(identities).toHaveLength(2);
      child.kill("SIGTERM");
      await exited;
      await requestClosed;
      await vi.waitFor(() => {
        for (const pid of identities) expect(() => process.kill(pid, 0)).toThrow();
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  },
);

it("terminal tails preserve the existing final twenty-line limit", async () => {
  const f = await fixture();
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  await f.emit(Buffer.from(Array.from({ length: 30 }, (_, i) => `line-${i}\n`).join("")));
  f.finish();
  await f.supervisor.settled("op");
  const tail = await f.supervisor.tail(ref, { maxBytes: 65536, signal });
  expect("data" in tail && Buffer.from(tail.data).toString()).toBe(
    Array.from({ length: 20 }, (_, i) => `line-${i + 10}\n`).join(""),
  );
  expect(tail).toMatchObject({ truncated: true });
});

it.runIf(process.platform === "darwin")(
  "background stop honors a bounded graceful shutdown before force",
  async () => {
    const { mkdir, realpath } = await import("node:fs/promises");
    const { startMacOperationWorker } = await import("../src/exec/operation-worker.js");
    const root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-grace-")));
    dirs.push(root);
    const stateDir = join(root, "state");
    await mkdir(stateDir, { mode: 0o700 });
    let armed!: () => void;
    const isArmed = new Promise<void>((r) => {
      armed = r;
    });
    const supervisor = new MacOperationSupervisor({
      stateDir,
      deviceId: "d",
      instanceGeneration: "g",
      start: startMacOperationWorker,
    });
    const script =
      "import signal,sys; signal.signal(signal.SIGTERM,lambda *args:(print('clean',flush=True),sys.exit(0))); print('armed',flush=True); signal.pause()";
    const req: MacWorkerRequest = {
      ...request(stateDir),
      scope: { ...scope, admitBeforeMs: Date.now() + 30000 },
      stateDir,
      args: {
        command: `/usr/bin/python3 -I -c ${shellQuote(script)}`,
        cwd: root,
        timeoutMs: 10000,
        maxOutputBytes: 1000,
      },
      onOutput: (b) => {
        if (b.toString() === "armed\n") armed();
      },
    };
    const ref = await supervisor.start(req, "grace", Date.now() + 60000, signal);
    try {
      await Promise.race([
        isArmed,
        supervisor.settled("op").then(() => {
          throw Error("Owned fixture exited before installing its handler");
        }),
      ]);
      expect(await supervisor.stop(ref, { graceMs: 1000, signal })).toEqual({ outcome: "stopped" });
      const tail = await supervisor.tail(ref, { maxBytes: 65536, signal });
      expect("data" in tail && Buffer.from(tail.data).toString()).toContain("clean");
    } finally {
      await supervisor.stop(ref, { graceMs: 0, signal });
    }
  },
);

it("retries a failed exact cancellation and preserves the completed stop outcome", async () => {
  const f = await fixture(1);
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  try {
    expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
      outcome: "cancel-pending",
    });
    expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
    expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
    expect(f.cancelled()).toBe(2);
  } finally {
    f.finish();
    await f.supervisor.settled("op");
  }
});
it("owner reconciliation retries already revoked work until exact cancellation succeeds", async () => {
  const f = await fixture(1);
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  try {
    await f.supervisor.reconcile(() => false, signal);
    expect(f.cancelled()).toBe(1);
    await f.supervisor.reconcile(() => true, signal);
    expect(f.cancelled()).toBe(2);
    expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
  } finally {
    f.finish();
    await f.supervisor.settled("op");
  }
});
it("natural completion resolves a prior pending cancellation without signaling again", async () => {
  const f = await fixture(true);
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
    outcome: "cancel-pending",
  });
  f.finish();
  await f.supervisor.settled("op");
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
    outcome: "already-exited",
    exitCode: 0,
    timedOut: false,
  });
  expect(f.cancelled()).toBe(1);
});
it("worker cancellation attempts retry failures and coalesce only the active attempt", async () => {
  const { createCancellationAttempt } = await import("../src/exec/operation-worker.js");
  let calls = 0;
  let finish!: () => void;
  const ended = new Promise<void>((r) => {
    finish = r;
  });
  const cancel = createCancellationAttempt(async () => {
    calls++;
    if (calls === 1) throw Error("transient owned signal failure");
    await ended;
  });
  await expect(cancel(0)).rejects.toThrow(/transient/);
  const one = cancel(0);
  const two = cancel(0);
  expect(calls).toBe(2);
  finish();
  await Promise.all([one, two]);
});

it("live tails withhold a trailing partial UTF-8 character until its next chunk", async () => {
  const f = await fixture();
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  try {
    const character = Buffer.from("😀");
    await f.emit(character.subarray(0, 2), "stdout");
    expect(await f.supervisor.tail(ref, { maxBytes: 65536, signal })).toEqual({
      data: Buffer.alloc(0),
      truncated: false,
    });
    await f.emit(character.subarray(2), "stdout");
    expect(await f.supervisor.tail(ref, { maxBytes: 65536, signal })).toEqual({
      data: character,
      truncated: false,
    });
  } finally {
    await f.supervisor.stop(ref, { graceMs: 0, signal });
  }
});
it("merged output preserves bytes even when source fragments are invalid UTF-8", async () => {
  const f = await fixture();
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  try {
    const out = Buffer.from("😀");
    const err = Buffer.from("€");
    await f.emit(out.subarray(0, 2), "stdout");
    await f.emit(err.subarray(0, 1), "stderr");
    await f.emit(out.subarray(2), "stdout");
    let tail = await f.supervisor.tail(ref, { maxBytes: 65536, signal });
    expect("data" in tail && Buffer.from(tail.data).toString()).toBe(
      Buffer.concat([out.subarray(0, 2), err.subarray(0, 1), out.subarray(2)]).toString(),
    );
    await f.emit(err.subarray(1), "stderr");
    tail = await f.supervisor.tail(ref, { maxBytes: 65536, signal });
    expect("data" in tail && Buffer.from(tail.data).toString()).toBe(
      Buffer.concat([
        out.subarray(0, 2),
        err.subarray(0, 1),
        out.subarray(2),
        err.subarray(1),
      ]).toString(),
    );
  } finally {
    await f.supervisor.stop(ref, { graceMs: 0, signal });
  }
});

it("concurrent stops retain the claimed winner after worker completion before cancellation settles", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cap-stop-winner-"));
  dirs.push(stateDir);
  let finish!: (value: typeof result) => void;
  let entered!: () => void;
  const cancelling = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const cancellationSettles = new Promise<void>((resolve) => {
    release = resolve;
  });
  const watched: boolean[] = [];
  let cancels = 0;
  const supervisor = new MacOperationSupervisor({
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 1,
    onLiveChanged: (live) => {
      watched.push(live);
    },
    start: async (request) => {
      await request.beforeLaunch();
      await request.onLaunch({ pid: 456, token: "owned-winner" });
      return {
        ready: Promise.resolve(),
        completion: new Promise<typeof result>((resolve) => {
          finish = resolve;
        }),
        cancel: async () => {
          cancels++;
          entered();
          await cancellationSettles;
        },
      };
    },
  });
  const ref = await supervisor.start(request(stateDir), "hash", 2000, signal);
  const first = supervisor.stop(ref, { graceMs: 0, signal });
  try {
    await cancelling;
    finish({ ...result, exitCode: null });
    const { vi } = await import("vitest");
    await vi.waitFor(() => expect(supervisor.ownership().workers).toBe(0));
    // the worker is gone but its cancellation is still owned: the owner watcher stays on (8.4)
    expect(supervisor.ownership().cancellations).toBe(1);
    expect(watched).not.toContain(false);
    const second = supervisor.stop(ref, { graceMs: 0, signal });
    // Wait behind the second stop's claim in the serialized journal queue.
    await supervisor.settled("op");
    release();
    expect(await Promise.all([first, second])).toEqual([
      { outcome: "stopped" },
      { outcome: "stopped" },
    ]);
    expect(cancels).toBe(1);
    expect(watched.at(-1)).toBe(false);
    expect(await supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
  } finally {
    release();
    finish(result);
    await first;
    await supervisor.settled("op");
  }
});

it.each([1, 2001])(
  "old-generation pending records cannot block current reconciliation at time %i",
  async (now) => {
    const { vi } = await import("vitest");
    const f = await fixture(true);
    const oldRef = await f.supervisor.start(request(f.stateDir), "old-hash", 2000, signal);
    expect(await f.supervisor.stop(oldRef, { graceMs: 0, signal })).toEqual({
      outcome: "cancel-pending",
    });
    let finish!: (value: typeof result) => void;
    let cancelled = 0;
    let started = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Error("Unexpected PID signal");
    });
    const current = new MacOperationSupervisor({
      stateDir: f.stateDir,
      deviceId: "d",
      instanceGeneration: "next",
      now: () => now,
      start: async (req) => {
        started++;
        await req.beforeLaunch();
        await req.onLaunch({ pid: 789, token: "current-owned" });
        return {
          ready: Promise.resolve(),
          completion: new Promise<typeof result>((resolve) => {
            finish = resolve;
          }),
          cancel: async () => {
            cancelled++;
            finish({ ...result, exitCode: null });
          },
        };
      },
    });
    const currentRequest = {
      ...request(f.stateDir),
      managedOutput: { artifactRoot: f.stateDir, outputPath: join(f.stateDir, "current.out") },
      scope: { ...scope, operationId: "current", admitBeforeMs: 4000 },
    };
    const ref = await current.start(currentRequest, "current-hash", 5000, signal);
    try {
      await current.reconcile(() => false, signal);
      expect(cancelled).toBe(1);
      expect(started).toBe(1);
      expect(f.cancelled()).toBe(1);
      expect(kill).not.toHaveBeenCalled();
      expect(await current.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
      await expect(current.start(request(f.stateDir), "old-hash", 5000, signal)).rejects.toThrow(
        /revoked/,
      );
      const file = (await readdir(f.stateDir)).find((name) =>
        name.startsWith("operation-journal-"),
      );
      const journal = JSON.parse(await readFile(join(f.stateDir, file as string), "utf8"));
      expect(
        journal.entries.find(
          (entry: { ref: { operationId: string } }) => entry.ref.operationId === "op",
        ),
      ).toMatchObject({
        ref: oldRef,
        revoked: true,
        state: "unknown",
        stop: { outcome: "cancel-pending" },
        hash: "old-hash",
      });
    } finally {
      kill.mockRestore();
      finish(result);
      await current.settled("current");
      f.finish();
      await f.supervisor.settled("op");
    }
  },
);

it.each(["stale", "invalid"])(
  "a %s pending control cannot erase a durably stopped journal outcome",
  async (kind) => {
    const f = await fixture();
    const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
    expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
    const { writeFile } = await import("node:fs/promises");
    const control = (await readdir(f.stateDir)).find((name) =>
      name.startsWith("operation-control-"),
    );
    if (!control) throw Error("Missing owned cancellation record");
    await writeFile(
      join(f.stateDir, control),
      kind === "invalid"
        ? "{"
        : JSON.stringify({ version: 1, ref, revoked: true, fault: false, stop: "cancel-pending" }),
    );
    for (let i = 0; i < 2; i++) {
      const recovered = new MacOperationSupervisor({
        stateDir: f.stateDir,
        deviceId: "d",
        instanceGeneration: "g",
        now: () => 1,
      });
      expect(await recovered.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
      await recovered.settled(ref.operationId);
    }
    expect(f.cancelled()).toBe(1);
  },
);
// Phase 8.4: graceful drain. A start RPC that already answered is not the task's owner: the
// supervisor keeps owning the worker, and a drain waits for it.
const idle = () => new Promise<void>((r) => setImmediate(r));
it("drain refuses fresh admission, keeps admitted retries and exact controls, and waits for an acknowledged task", async () => {
  const f = await fixture();
  const req = request(f.stateDir);
  const ref = await f.supervisor.start(req, "hash", 2000, signal);
  f.supervisor.beginDrain();
  const fresh = {
    ...req,
    scope: { ...scope, operationId: "fresh", tag: "fresh" },
    managedOutput: { artifactRoot: f.stateDir, outputPath: join(f.stateDir, "fresh.out") },
  };
  await expect(f.supervisor.start(fresh, "hash", 2000, signal)).rejects.toThrow(/draining/);
  await expect(f.supervisor.execute(fresh, "hash", signal)).rejects.toThrow(/draining/);
  expect(f.starts()).toBe(1);
  // a retry of an admitted id is recovery, not a new admission
  expect(await f.supervisor.start(req, "hash", 2000, signal)).toEqual(ref);
  expect(await f.supervisor.status(ref, signal)).toEqual({ state: "running" });
  expect(f.supervisor.ownership()).toMatchObject({ workers: 1 });
  let drained = false;
  const settling = f.supervisor.settle(new AbortController().signal).then(() => {
    drained = true;
  });
  await idle();
  await idle();
  // the start RPC answered long ago; the worker still runs and drain has not finished
  expect(drained).toBe(false);
  expect(f.cancelled()).toBe(0);
  f.finish();
  await settling;
  expect(f.supervisor.ownership()).toEqual({
    workers: 0,
    cancellations: 0,
    collectors: 0,
    persistence: 0,
  });
  expect(await f.supervisor.status(ref, signal)).toEqual({
    state: "exited",
    exitCode: 0,
    timedOut: false,
  });
});
it("a drain that cannot settle reports what is still owned and stays draining", async () => {
  const f = await fixture(true);
  const req = request(f.stateDir);
  const ref = await f.supervisor.start(req, "hash", 2000, signal);
  // the owner's cancellation cannot be established: the stop stays pending
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
    outcome: "cancel-pending",
  });
  f.supervisor.beginDrain();
  const giveUp = new AbortController();
  const settling = f.supervisor.settle(giveUp.signal);
  await idle();
  giveUp.abort(new Error("drain timeout"));
  const error = await settling.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toMatchObject({ name: "DrainPendingError", pending: { workers: 1 } });
  // never reusable after a timed-out drain
  await expect(
    f.supervisor.start(
      { ...req, scope: { ...scope, operationId: "later", tag: "later" } },
      "hash",
      2000,
      signal,
    ),
  ).rejects.toThrow(/draining/);
  // a repeated cancellation delivery is still served by the exact owner
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
    outcome: "cancel-pending",
  });
  expect(f.cancelled()).toBe(2);
});

// Review M4: each ownership class keeps a drain open on its own.
const drainOpen = async (settling: Promise<void>) => {
  let done = false;
  void settling.then(() => {
    done = true;
  });
  for (let i = 0; i < 5; i++) await idle();
  return () => done;
};
it("drain waits for a pending exact cancellation after its worker is gone", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cap-drain-cancel-"));
  dirs.push(stateDir);
  let finish!: (value: typeof result) => void;
  let entered!: () => void;
  const cancelling = new Promise<void>((r) => {
    entered = r;
  });
  let release!: () => void;
  const settles = new Promise<void>((r) => {
    release = r;
  });
  const supervisor = new MacOperationSupervisor({
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 1,
    start: async (r) => {
      await r.beforeLaunch();
      await r.onLaunch({ pid: 7, token: "pending-cancel" });
      return {
        ready: Promise.resolve(),
        completion: new Promise<typeof result>((resolve) => {
          finish = resolve;
        }),
        cancel: async () => {
          entered();
          await settles;
        },
      };
    },
  });
  const ref = await supervisor.start(request(stateDir), "hash", 2000, signal);
  const stopping = supervisor.stop(ref, { graceMs: 0, signal });
  await cancelling;
  finish({ ...result, exitCode: null });
  const { vi } = await import("vitest");
  await vi.waitFor(() =>
    expect(supervisor.ownership()).toMatchObject({ workers: 0, cancellations: 1 }),
  );
  supervisor.beginDrain();
  const done = await drainOpen(supervisor.settle(new AbortController().signal));
  expect(done()).toBe(false);
  release();
  expect(await stopping).toEqual({ outcome: "stopped" });
  await vi.waitFor(() => expect(done()).toBe(true));
});
it("drain waits for an output read in flight after the task ended", async () => {
  let hold: Promise<void> | undefined;
  let entered!: () => void;
  const reading = new Promise<void>((r) => {
    entered = r;
  });
  const f = await fixture(false, async (name) => {
    if (name === "read" && hold) {
      entered();
      await hold;
    }
  });
  const ref = await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  await f.emit(Buffer.from("hello"));
  f.finish();
  await f.supervisor.settled("op");
  let release!: () => void;
  hold = new Promise<void>((r) => {
    release = r;
  });
  const read = f.supervisor.readOutput(ref, { offset: 0, maxBytes: 5, signal });
  await reading;
  expect(f.supervisor.ownership()).toMatchObject({ workers: 0, collectors: 1 });
  f.supervisor.beginDrain();
  const done = await drainOpen(f.supervisor.settle(new AbortController().signal));
  expect(done()).toBe(false);
  release();
  expect(await read).toMatchObject({ totalBytes: 5 });
  const { vi } = await import("vitest");
  await vi.waitFor(() => expect(done()).toBe(true));
});
it("drain retries dirty control persistence once and waits for it", async () => {
  let failControl = true;
  let failAppend = true;
  let hold: Promise<void> | undefined;
  let entered!: () => void;
  const persisting = new Promise<void>((r) => {
    entered = r;
  });
  const f = await fixture(false, async (name) => {
    if (name === "append-spool-sync" && failAppend) {
      failAppend = false;
      throw new Error("disk full");
    }
    if (name === "control-persist") {
      if (failControl) throw new Error("control write failed");
      if (hold) {
        entered();
        await hold;
      }
    }
  });
  await f.supervisor.start(request(f.stateDir), "hash", 2000, signal);
  // a collector fault cancels the owner and schedules control persistence, which fails
  await f.emit(Buffer.from("x")).catch(() => {});
  const { vi } = await import("vitest");
  await vi.waitFor(() =>
    expect(f.supervisor.ownership()).toEqual({
      workers: 0,
      cancellations: 0,
      collectors: 0,
      persistence: 1,
    }),
  );
  failControl = false;
  let release!: () => void;
  hold = new Promise<void>((r) => {
    release = r;
  });
  f.supervisor.beginDrain();
  const settling = f.supervisor.settle(new AbortController().signal);
  const done = await drainOpen(settling);
  await persisting;
  expect(done()).toBe(false);
  release();
  // the drain itself is the convergence condition (no bounded poll: a loaded runner is slow)
  await settling;
  expect(done()).toBe(true);
  expect(f.supervisor.ownership().persistence).toBe(0);
});
it("keeps a native read's bytes out of the journal; a restarted retry gets an unknown outcome", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-read-"));
  dirs.push(stateDir);
  const dataB64 = Buffer.from("secret file bytes ".repeat(100)).toString("base64");
  const options = {
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 1,
    start: async (r: MacWorkerRequest) => {
      await r.beforeLaunch();
      await r.onLaunch({ pid: 123, token: "trusted-child" });
      return {
        ready: Promise.resolve(),
        completion: Promise.resolve({ dataB64, truncated: false }),
        cancel: async () => {},
      };
    },
  };
  const supervisor = new MacOperationSupervisor(options);
  const read = {
    kind: "native" as const,
    native: { method: "readFile" as const, path: "/f", maxBytes: 4096 },
    purpose: "operation" as const,
    scope,
    grant,
    stateDir,
    pythonPath: "/usr/bin/python3",
    beforeLaunch: async () => {},
    onLaunch: async () => {},
  };
  expect(await supervisor.execute(read, "hash", signal)).toEqual({ dataB64, truncated: false });
  // a retry in this process still answers from the retained result
  expect(await supervisor.execute(read, "hash", signal)).toEqual({ dataB64, truncated: false });
  const journal = (await readdir(stateDir)).filter((name) => name.startsWith("operation-journal-"));
  for (const name of journal)
    expect(await readFile(join(stateDir, name), "utf8")).not.toContain(dataB64.slice(0, 40));
  const recovered = new MacOperationSupervisor(options);
  await expect(recovered.execute(read, "hash", signal)).rejects.toThrow(/outcome is unknown/);
  // the read completed: it is no retirement obligation for another generation
  expect(recovered.retirementObligations("next")).toBe(0);
  await expect(recovered.execute(read, "changed", signal)).rejects.toThrow(/input/);
});
it("bounds the read bytes it retains in memory: past the budget the oldest reads answer unknown", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-budget-"));
  dirs.push(stateDir);
  const payload = (n: number) => Buffer.alloc(1000, n).toString("base64");
  const supervisor = new MacOperationSupervisor({
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 1,
    retainedReadBytes: 2500,
    start: async (r: MacWorkerRequest) => {
      await r.beforeLaunch();
      await r.onLaunch({ pid: 123, token: "trusted-child" });
      const n = Number(r.scope.operationId.slice(1));
      return {
        ready: Promise.resolve(),
        completion: Promise.resolve({ dataB64: payload(n), truncated: false }),
        cancel: async () => {},
      };
    },
  });
  const read = (n: number) => ({
    kind: "native" as const,
    native: { method: "readFile" as const, path: "/f", maxBytes: 4096 },
    purpose: "operation" as const,
    scope: { ...scope, operationId: `r${n}` },
    grant,
    stateDir,
    pythonPath: "/usr/bin/python3",
    beforeLaunch: async () => {},
    onLaunch: async () => {},
  });
  for (const n of [1, 2, 3]) await supervisor.execute(read(n), `h${n}`, signal);
  // 3000 retained bytes exceed 2500: the oldest read gave its bytes up
  await expect(supervisor.execute(read(1), "h1", signal)).rejects.toThrow(/outcome is unknown/);
  for (const n of [2, 3])
    expect(await supervisor.execute(read(n), `h${n}`, signal)).toEqual({
      dataB64: payload(n),
      truncated: false,
    });
  expect(supervisor.retirementObligations("next")).toBe(0);
});

describe("expired entries of an earlier generation", () => {
  const legacyEntry = (operationId: string, extra: Record<string, unknown> = {}) => ({
    ref: {
      executionId: `e-${operationId}`,
      operationId,
      instanceId: "d",
      instanceGeneration: "old",
    },
    admitBeforeMs: 100,
    hash: "h",
    retainUntilMs: 100,
    state: "unknown",
    revoked: false,
    ...extra,
  });
  // a journal as an earlier device version left it on disk (journal equal to its rollback floor)
  const recovered = async (entries: unknown[], now = 1000) => {
    const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-legacy-"));
    dirs.push(stateDir);
    const file = join(stateDir, `operation-journal-${digest("d")}.json`);
    const text = JSON.stringify({ version: 1, entries });
    await writeFile(file, text);
    await writeFile(`${file}.rollback`, text);
    return new MacOperationSupervisor({
      stateDir,
      deviceId: "d",
      instanceGeneration: "old",
      now: () => now,
      start: async () => {
        throw Error("must not launch");
      },
    });
  };

  it("an expired entry emptied of its identity and payload is no obligation", async () => {
    const supervisor = await recovered([
      legacyEntry("a"),
      legacyEntry("b", { stop: { outcome: "cancel-pending" } }),
    ]);
    expect(supervisor.retirementObligations("next")).toBe(0);
    expect(supervisor.blockersBesidesLiveBackground("next")).toBe(0);
  });

  it("an entry that still has a launch identity blocks, expired or not", async () => {
    const supervisor = await recovered([legacyEntry("a", { identity: { pid: 123, token: "t" } })]);
    expect(supervisor.retirementObligations("next")).toBe(1);
    expect(supervisor.blockersBesidesLiveBackground("next")).toBe(1);
  });

  it("an unknown entry within its retention blocks", async () => {
    const supervisor = await recovered([legacyEntry("a")], 50);
    expect(supervisor.retirementObligations("next")).toBe(1);
    expect(supervisor.blockersBesidesLiveBackground("next")).toBe(1);
  });

  it("an expired entry whose output was never cleaned blocks", async () => {
    const supervisor = await recovered([
      legacyEntry("a", {
        output: {
          locator: { committed: 0 },
          state: "uncertain",
          interruptedCancellation: true,
        },
      }),
    ]);
    expect(supervisor.retirementObligations("next")).toBe(1);
  });
});

const foreground = (stateDir: string, operationId: string, admitBeforeMs: number) => {
  const { managedOutput: _, ...rest } = request(stateDir);
  return { ...rest, scope: { ...scope, operationId, tag: operationId, admitBeforeMs } };
};
it("a completed exec stays settled once its retained payload expired", async () => {
  const f = await fixture();
  const first = f.supervisor.execute(foreground(f.stateDir, "op", 1000), "hash", signal);
  await vi.waitFor(() => expect(f.starts()).toBe(1));
  f.finish();
  expect(await first).toEqual(result);
  await vi.waitFor(() => expect(f.supervisor.ownership().workers).toBe(0));
  // past the exec's retention, the next admission sweeps the retained payload away
  f.setNow(70_000);
  const second = f.supervisor.execute(foreground(f.stateDir, "op-2", 80_000), "h2", signal);
  await vi.waitFor(() => expect(f.starts()).toBe(2));
  f.finish();
  await second;
  const journal = (await readdir(f.stateDir)).find((name) =>
    /^operation-journal-[a-f0-9]+\.json$/.test(name),
  );
  const entries = JSON.parse(await readFile(join(f.stateDir, journal as string), "utf8")).entries;
  const swept = entries.find((e: { ref: { operationId: string } }) => e.ref.operationId === "op");
  expect(swept).toMatchObject({ state: "completed" });
  expect(swept.result).toBeUndefined();
  expect(swept.request).toBeUndefined();
  expect(f.supervisor.retirementObligations("next")).toBe(0);
  expect(f.supervisor.blockersBesidesLiveBackground("next")).toBe(0);
  // a retry past retention reports an unknown outcome, never an empty result
  await expect(
    f.supervisor.execute(foreground(f.stateDir, "op", 1000), "hash", signal),
  ).rejects.toThrow(/unknown/);
});

it("an unknown exec of a lost process keeps its identity past retention and keeps blocking", async () => {
  const f = await fixture();
  const running = f.supervisor.execute(foreground(f.stateDir, "op", 1000), "hash", signal);
  await vi.waitFor(() => expect(f.starts()).toBe(1));
  let now = 1;
  const restarted = new MacOperationSupervisor({
    stateDir: f.stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => now,
    start: async (r: MacWorkerRequest) => {
      await r.beforeLaunch();
      await r.onLaunch({ pid: 456, token: "other-child" });
      return {
        ready: Promise.resolve(),
        completion: Promise.resolve(result),
        cancel: async () => {},
      };
    },
  });
  now = 70_000;
  // an admission sweeps every entry past its retention
  await restarted.execute(foreground(f.stateDir, "op-2", 80_000), "h2", signal);
  await vi.waitFor(() => expect(restarted.ownership().workers).toBe(0));
  const journal = (await readdir(f.stateDir)).find((name) =>
    /^operation-journal-[a-f0-9]+\.json$/.test(name),
  );
  const entries = JSON.parse(await readFile(join(f.stateDir, journal as string), "utf8")).entries;
  const lost = entries.find((e: { ref: { operationId: string } }) => e.ref.operationId === "op");
  expect(lost).toMatchObject({ state: "unknown", identity: { pid: 123 } });
  expect(lost.request).toBeUndefined();
  expect(restarted.retirementObligations("next")).toBe(1);
  expect(restarted.blockersBesidesLiveBackground("next")).toBe(1);
  f.finish();
  await running;
});

// A settled entry is dropped an hour past its retention; anything still owed stays. The commit
// that pruned is accepted as the successor on restart, and the dropped id stays spent.
it("an admission that lapses while the device is busy is no scope refusal: nothing ran, retry", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-lapse-"));
  dirs.push(stateDir);
  let now = 1;
  let spawned = false;
  const supervisor = new MacOperationSupervisor({
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => now,
    start: async (r: MacWorkerRequest) => {
      // the device took past the admission deadline to reach the launch
      now = 50_000;
      await r.beforeLaunch();
      spawned = true;
      throw Error("must not launch");
    },
  });
  const request = {
    kind: "native" as const,
    native: { method: "stat" as const, path: "/f" },
    purpose: "operation" as const,
    scope: { ...scope, operationId: "late", tag: "late", admitBeforeMs: 30_000 },
    grant,
    stateDir,
    pythonPath: "/usr/bin/python3",
    beforeLaunch: async () => {},
    onLaunch: async () => {},
  };
  const error = await supervisor.execute(request, "h", signal).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(spawned).toBe(false);
  expect(isSandboxScopeDeniedError(error)).toBe(false);
  expect((error as Error).message).toMatch(/too busy.*nothing ran.*retry/);
});

it("prunes settled entries past retention, keeps owed ones, and a restart accepts the pruned commit", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-prune-"));
  dirs.push(stateDir);
  const hour = 60 * 60 * 1000;
  const entry = (operationId: string, extra: Record<string, unknown> = {}) => ({
    ref: { executionId: `e-${operationId}`, operationId, instanceId: "d", instanceGeneration: "g" },
    admitBeforeMs: 100,
    hash: "h",
    retainUntilMs: 100,
    state: "completed",
    revoked: false,
    ...extra,
  });
  const file = join(stateDir, `operation-journal-${digest("d")}.json`);
  const text = JSON.stringify({
    version: 1,
    entries: [
      entry("settled"),
      entry("settled-unknown", { state: "unknown" }),
      entry("recent", { retainUntilMs: 2 * hour }),
      entry("lost", { state: "unknown", identity: { pid: 123, token: "t" } }),
      entry("revoked", { revoked: true, stop: { outcome: "stopped" } }),
      // a revocation recorded before the request arrived: it never launched, nothing is owed
      entry("revoked-never-launched", {
        state: "unknown",
        hash: "revoked",
        revoked: true,
        stop: { outcome: "cancel-pending" },
      }),
      // a revoked lost process: its stop is owed until it is proven gone
      entry("revoked-lost", {
        state: "unknown",
        identity: { pid: 124, token: "t" },
        revoked: true,
        stop: { outcome: "cancel-pending" },
      }),
      entry("cancel-owed", { state: "unknown", stop: { outcome: "cancel-pending" } }),
      entry("uncleaned", {
        output: { locator: { committed: 0 }, state: "complete", interruptedCancellation: false },
      }),
    ],
  });
  await writeFile(file, text);
  await writeFile(`${file}.rollback`, text);
  let now = 1;
  const options = {
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => now,
    start: async (r: MacWorkerRequest) => {
      await r.beforeLaunch();
      await r.onLaunch({ pid: 456, token: "child" });
      return {
        ready: Promise.resolve(),
        completion: Promise.resolve({ size: 1, isDir: false }),
        cancel: async () => {},
      };
    },
  };
  const stat = (operationId: string, admitBeforeMs: number) => ({
    kind: "native" as const,
    native: { method: "stat" as const, path: "/f" },
    purpose: "operation" as const,
    scope: { ...scope, operationId, tag: operationId, admitBeforeMs },
    grant,
    stateDir,
    pythonPath: "/usr/bin/python3",
    beforeLaunch: async () => {},
    onLaunch: async () => {},
  });
  const supervisor = new MacOperationSupervisor(options);
  await supervisor.execute(stat("new", 30_000), "h-new", signal);
  // an hour on: a retry's admission sweeps, so the journal's last commit is the pruning one
  now = hour + 10_000;
  await expect(supervisor.execute(stat("new", 30_000), "h-new", signal)).rejects.toThrow(/unknown/);
  const kept = JSON.parse(await readFile(file, "utf8")).entries.map(
    (e: { ref: { operationId: string } }) => e.ref.operationId,
  );
  expect(kept.sort()).toEqual([
    "cancel-owed",
    "lost",
    "new",
    "recent",
    "revoked-lost",
    "uncleaned",
  ]);
  // the last commit on disk is a successor that dropped entries of its predecessor
  const restarted = new MacOperationSupervisor(options);
  expect(await restarted.execute(stat("after", now + 30_000), "h-after", signal)).toEqual({
    size: 1,
    isDir: false,
  });
  // a duplicate delivery of a pruned operation carries its long-past deadline: never run again
  await expect(restarted.execute(stat("settled", 100), "h", signal)).rejects.toThrow(/expired/);
  // a pruned revocation too: its request arriving late is expired, never run
  await expect(restarted.execute(stat("revoked-never-launched", 100), "h", signal)).rejects.toThrow(
    /expired/,
  );
});

it("removes a pruned revocation's control file once the pruning commit landed", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-prune-control-"));
  dirs.push(stateDir);
  const hour = 60 * 60 * 1000;
  const ref = { executionId: "e-r", operationId: "r", instanceId: "d", instanceGeneration: "g" };
  const file = join(stateDir, `operation-journal-${digest("d")}.json`);
  const text = JSON.stringify({
    version: 1,
    entries: [
      {
        ref,
        admitBeforeMs: 100,
        hash: "revoked",
        retainUntilMs: 100,
        state: "unknown",
        revoked: true,
        stop: { outcome: "cancel-pending" },
      },
    ],
  });
  await writeFile(file, text);
  await writeFile(`${file}.rollback`, text);
  const control = join(stateDir, `operation-control-${digest(ref)}.json`);
  await writeFile(
    control,
    JSON.stringify({ version: 1, ref, revoked: true, fault: false, stop: "cancel-pending" }),
  );
  const supervisor = new MacOperationSupervisor({
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 2 * hour,
    start: async (r: MacWorkerRequest) => {
      await r.beforeLaunch();
      await r.onLaunch({ pid: 456, token: "child" });
      return {
        ready: Promise.resolve(),
        completion: Promise.resolve({ size: 1, isDir: false }),
        cancel: async () => {},
      };
    },
  });
  // any admission sweeps the journal
  await supervisor.execute(
    {
      kind: "native" as const,
      native: { method: "stat" as const, path: "/f" },
      purpose: "operation" as const,
      scope: { ...scope, operationId: "next", tag: "next", admitBeforeMs: 3 * hour },
      grant,
      stateDir,
      pythonPath: "/usr/bin/python3",
      beforeLaunch: async () => {},
      onLaunch: async () => {},
    },
    "h-next",
    signal,
  );
  const kept = JSON.parse(await readFile(file, "utf8")).entries.map(
    (e: { ref: { operationId: string } }) => e.ref.operationId,
  );
  expect(kept).toEqual(["next"]);
  expect((await readdir(stateDir)).filter((n) => n.startsWith("operation-control-"))).toEqual([]);
});

describe("orphans a lost device process left behind", () => {
  // a fake process table: SIGKILL (of a process or a group) removes rows, unless kills do not take;
  // `signals` records every signal sent, SIGSTOP included
  const table = (rows: Omit<ProcessRow, "ppid">[], opts: { killTakes?: boolean } = {}) => {
    const live: ProcessRow[] = rows.map((row) => ({ ppid: 1, ...row }));
    const signals: string[] = [];
    const remove = (match: (row: ProcessRow) => boolean) => {
      if (opts.killTakes === false) return;
      for (let i = live.length - 1; i >= 0; i--)
        if (match(live[i] as ProcessRow)) live.splice(i, 1);
    };
    const processes: OrphanProcesses = {
      list: async () => live.map((row) => ({ ...row })),
      signal: (pid, signal) => {
        signals.push(`${signal} ${pid}`);
        if (signal === "SIGKILL") remove((row) => row.pid === pid);
      },
      killGroup: (pgid) => {
        signals.push(`SIGKILL -${pgid}`);
        remove((row) => row.pgid === pgid);
      },
      pause: async () => {},
    };
    return { rows: live, signals, processes };
  };
  const entry = (operationId: string, extra: Record<string, unknown> = {}) => ({
    ref: {
      executionId: `e-${operationId}`,
      operationId,
      instanceId: "d",
      instanceGeneration: "old",
    },
    admitBeforeMs: 100_000,
    hash: "h",
    retainUntilMs: 100_000,
    state: "unknown",
    revoked: false,
    ...extra,
  });
  const journalAt = async (entries: unknown[]) => {
    const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-orphans-"));
    dirs.push(stateDir);
    const file = join(stateDir, `operation-journal-${digest("d")}.json`);
    const text = JSON.stringify({ version: 1, entries });
    await writeFile(file, text);
    await writeFile(`${file}.rollback`, text);
    return { stateDir, file };
  };
  const open = (stateDir: string, processes?: OrphanProcesses) =>
    new MacOperationSupervisor({
      stateDir,
      deviceId: "d",
      instanceGeneration: "old",
      now: () => 10_000_000,
      ...(processes ? { orphans: processes } : {}),
      start: async () => {
        throw Error("must not launch");
      },
    });
  const byId = (entries: { ref: { operationId: string } }[], id: string) =>
    entries.find((e) => e.ref.operationId === id) as Record<string, unknown>;

  it("settles the journal the observed device was stuck on: lost execs beside revoked never-launched ones", async () => {
    const { stateDir, file } = await journalAt([
      entry("a", { identity: { pid: 61001, token: "t1" } }),
      entry("b", { identity: { pid: 61002, token: "t2" } }),
      entry("c", { identity: { pid: 61003, token: "t3" } }),
      entry("r1", { revoked: true, hash: "revoked", stop: { outcome: "cancel-pending" } }),
      entry("r2", { revoked: true, hash: "revoked", stop: { outcome: "cancel-pending" } }),
    ]);
    // without orphan reaping (the earlier behaviour) the three lost execs block for good
    const before = open(stateDir);
    expect(before.retirementObligations("next")).toBe(3);
    before.close();
    const t = table([]);
    const supervisor = open(stateDir, t.processes);
    await supervisor.settleOrphans();
    expect(supervisor.retirementObligations("next")).toBe(0);
    expect(supervisor.blockersBesidesLiveBackground("next")).toBe(0);
    expect(t.signals).toEqual([]);
    // durable: a restarted program without reaping finds them settled too
    supervisor.close();
    expect(open(stateDir).retirementObligations("next")).toBe(0);
    const entries = JSON.parse(await readFile(file, "utf8")).entries;
    expect(byId(entries, "a")).toMatchObject({ state: "unknown", stop: { outcome: "stopped" } });
    expect(byId(entries, "a").identity).toBeUndefined();
  });

  it("revoked entries that never launched are no obligation, before or after the reap", async () => {
    const { stateDir } = await journalAt([
      entry("r1", { revoked: true, hash: "revoked", stop: { outcome: "cancel-pending" } }),
    ]);
    const supervisor = open(stateDir, table([]).processes);
    expect(supervisor.retirementObligations("next")).toBe(0);
    await supervisor.settleOrphans();
    expect(supervisor.retirementObligations("next")).toBe(0);
  });

  it("a revoked operation that never launched stops for good: the owner reconcile no longer rewrites the journal", async () => {
    const { stateDir, file } = await journalAt([
      entry("r1", { revoked: true, hash: "revoked", stop: { outcome: "cancel-pending" } }),
      entry("r2", { revoked: true, hash: "revoked", stop: { outcome: "cancel-pending" } }),
    ]);
    const revision = async () =>
      JSON.parse(await readFile(file, "utf8")).transaction?.revision as number | undefined;
    const supervisor = open(stateDir, table([]).processes);
    await supervisor.settleOrphans();
    // the reconcile the owner ceiling check runs every two seconds
    await supervisor.reconcile(() => true, signal);
    const entries = JSON.parse(await readFile(file, "utf8")).entries;
    expect(byId(entries, "r1")).toMatchObject({ revoked: true, stop: { outcome: "stopped" } });
    expect(byId(entries, "r2")).toMatchObject({ revoked: true, stop: { outcome: "stopped" } });
    const settled = await revision();
    for (let i = 0; i < 5; i++) await supervisor.reconcile(() => true, signal);
    expect(await revision()).toBe(settled);
    expect(await supervisor.stop(byId(entries, "r1").ref as never, { graceMs: 0, signal })).toEqual(
      { outcome: "stopped" },
    );
    expect(await revision()).toBe(settled);
  });

  it("a lost process's owed stop is journaled once, not at every reconcile", async () => {
    const { stateDir, file } = await journalAt([
      entry("lost", {
        identity: { pid: 63001, token: "t" },
        revoked: true,
        stop: { outcome: "cancel-pending" },
      }),
    ]);
    const revision = async () =>
      JSON.parse(await readFile(file, "utf8")).transaction?.revision as number | undefined;
    // its process is still there and not provably gone: the stop stays owed
    const supervisor = open(stateDir);
    await supervisor.reconcile(() => true, signal);
    const owed = await revision();
    for (let i = 0; i < 5; i++) await supervisor.reconcile(() => true, signal);
    expect(await revision()).toBe(owed);
    const entries = JSON.parse(await readFile(file, "utf8")).entries;
    expect(byId(entries, "lost")).toMatchObject({ stop: { outcome: "cancel-pending" } });
  });

  it("settles a reused pid without a signal: another group's member, or a leader started later", async () => {
    const { stateDir } = await journalAt([
      // the pid now belongs to a member of another group
      entry("member", { identity: { pid: 62001, token: "t" } }),
      // a group leader that started long after the entry's admission deadline
      entry("later", { identity: { pid: 62002, token: "t" } }),
      // recorded with a launch time; the leader at that pid started an hour after it
      entry("timed", { identity: { pid: 62003, token: "t", launchedAtMs: 5_000_000 } }),
    ]);
    const t = table([
      { pid: 62001, pgid: 1, startMs: 0 },
      { pid: 62002, pgid: 62002, startMs: 100_000 + LEGACY_MARGIN_MS + 1000 },
      { pid: 62003, pgid: 62003, startMs: 5_000_000 + 3_600_000 },
    ]);
    const supervisor = open(stateDir, t.processes);
    await supervisor.settleOrphans();
    expect(supervisor.retirementObligations("next")).toBe(0);
    expect(t.signals).toEqual([]);
  });

  it("never kills or settles what it cannot prove ours", async () => {
    const { stateDir } = await journalAt([
      // an earlier version's identity: a leader that started before the admission deadline
      entry("legacy", { identity: { pid: 63001, token: "t" } }),
      // the leader is gone but its group still has a member
      entry("remnant", { identity: { pid: 63002, token: "t", launchedAtMs: 50_000 } }),
      // a live leader that looks older than its launch window (a late record, a stepped clock)
      entry("old-looking", { identity: { pid: 63003, token: "t", launchedAtMs: 500_000 } }),
    ]);
    const t = table([
      { pid: 63001, pgid: 63001, startMs: 90_000 },
      { pid: 63010, pgid: 63002, startMs: 60_000 },
      { pid: 63003, pgid: 63003, startMs: 500_000 - 120_000 },
    ]);
    const supervisor = open(stateDir, t.processes);
    await supervisor.settleOrphans();
    expect(t.signals).toEqual([]);
    expect(supervisor.retirementObligations("next")).toBe(3);
  });

  it("kills a provably ours process tree, settles once it is gone, and blocks while it is not", async () => {
    const launchedAtMs = 50_400;
    const rows = () => [
      { pid: 64001, pgid: 64001, startMs: 50_000 },
      { pid: 64002, pgid: 64001, startMs: 50_000 },
    ];
    const journal = [entry("live", { identity: { pid: 64001, token: "t", launchedAtMs } })];
    const stubborn = await journalAt(journal);
    const refused = table(rows(), { killTakes: false });
    const blocked = open(stubborn.stateDir, refused.processes);
    await blocked.settleOrphans();
    expect(refused.signals).toContain("SIGKILL 64001");
    expect(blocked.retirementObligations("next")).toBe(1);
    // nothing was written: the journal on disk keeps the entry unsettled, identity and all
    const kept = byId(JSON.parse(await readFile(stubborn.file, "utf8")).entries, "live");
    expect(kept).toMatchObject({ state: "unknown", identity: { pid: 64001, launchedAtMs } });
    expect(kept.stop).toBeUndefined();
    // while it still owns work, close refuses with the unsettled kind
    const owned = vi
      .spyOn(blocked, "ownership")
      .mockReturnValue({ workers: 1, cancellations: 0, collectors: 0, persistence: 0 });
    expect(() => blocked.close()).toThrow(SandboxWorkUnsettledError);
    owned.mockRestore();
    blocked.close();
    expect(open(stubborn.stateDir).retirementObligations("next")).toBe(1);

    const { stateDir } = await journalAt(journal);
    const t = table(rows());
    const supervisor = open(stateDir, t.processes);
    await supervisor.settleOrphans();
    expect(t.signals).toEqual([
      "SIGSTOP 64001",
      "SIGSTOP 64002",
      "SIGKILL 64001",
      "SIGKILL 64002",
      "SIGKILL -64001",
    ]);
    expect(t.rows).toEqual([]);
    expect(supervisor.retirementObligations("next")).toBe(0);
  });

  it("a settlement whose journal write fails is rolled back and retried by a later pass", async () => {
    const { stateDir, file } = await journalAt([
      entry("a", { identity: { pid: 67001, token: "t" } }),
    ]);
    let failWrites = true;
    const supervisor = new MacOperationSupervisor({
      stateDir,
      deviceId: "d",
      instanceGeneration: "old",
      now: () => 10_000_000,
      orphans: table([]).processes,
      beforePersist: () => {
        if (failWrites) throw Error("disk full");
      },
      start: async () => {
        throw Error("must not launch");
      },
    });
    await supervisor.settleOrphans();
    // not durable, so not settled: neither in memory nor on disk
    expect(supervisor.retirementObligations("next")).toBe(1);
    expect(byId(JSON.parse(await readFile(file, "utf8")).entries, "a")).toMatchObject({
      identity: { pid: 67001 },
    });
    failWrites = false;
    await supervisor.settleOrphans();
    expect(supervisor.retirementObligations("next")).toBe(0);
    expect(byId(JSON.parse(await readFile(file, "utf8")).entries, "a")).toMatchObject({
      stop: { outcome: "stopped" },
    });
  });

  it("a native operation that fails after its helper launched settles once the helper is gone", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-native-fail-"));
    dirs.push(stateDir);
    const t = table([]);
    const options = {
      stateDir,
      deviceId: "d",
      instanceGeneration: "g",
      orphans: t.processes,
      start: async (r: MacWorkerRequest) => {
        await r.beforeLaunch();
        await r.onLaunch({ pid: 65001, token: "helper" });
        const failed = Promise.reject(
          Object.assign(new Error("ENOTDIR: not a directory, open '/s/.capybara/x.json'"), {
            code: "ENOTDIR",
          }),
        );
        failed.catch(() => {});
        return { ready: Promise.resolve(), completion: failed, cancel: async () => {} };
      },
    };
    const supervisor = new MacOperationSupervisor(options);
    const write = {
      kind: "native" as const,
      native: { method: "writeFile" as const, path: "/s/.capybara/x.json", dataB64: "" },
      purpose: "preparation" as const,
      scope: { ...scope, operationId: "prep", tag: "prep", admitBeforeMs: Date.now() + 30_000 },
      grant,
      stateDir,
      pythonPath: "/usr/bin/python3",
      beforeLaunch: async () => {},
      onLaunch: async () => {},
    };
    await expect(supervisor.execute(write, "hash", signal)).rejects.toThrow(/ENOTDIR/);
    await vi.waitFor(() => expect(supervisor.ownership().workers).toBe(0));
    await supervisor.settleOrphans();
    expect(supervisor.retirementObligations("next")).toBe(0);
    // a later program run (of another generation) finds it settled on disk
    supervisor.close();
    const { orphans: _, ...withoutReaping } = options;
    const next = new MacOperationSupervisor(withoutReaping);
    expect(next.retirementObligations("next")).toBe(0);
  });

  it("journals the launch time the spawner read next to its spawn, not a later one", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-launch-time-"));
    dirs.push(stateDir);
    const supervisor = new MacOperationSupervisor({
      stateDir,
      deviceId: "d",
      instanceGeneration: "g",
      start: async (r: MacWorkerRequest) => {
        await r.beforeLaunch();
        await r.onLaunch({ pid: 68001, token: "child", launchedAtMs: 42_000 });
        return {
          ready: Promise.resolve(),
          completion: new Promise(() => {}),
          cancel: async () => {},
        };
      },
    });
    void supervisor.execute(foreground(stateDir, "op", Date.now() + 30_000), "hash", signal);
    const journal = join(stateDir, `operation-journal-${digest("d")}.json`);
    await vi.waitFor(async () =>
      expect(byId(JSON.parse(await readFile(journal, "utf8")).entries, "op")).toMatchObject({
        state: "running",
        identity: { pid: 68001, launchedAtMs: 42_000 },
      }),
    );
  });

  it("never touches an operation the current run owns live", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "cap-supervisor-live-"));
    dirs.push(stateDir);
    let finish!: (v: typeof result) => void;
    const t = table([]);
    const supervisor = new MacOperationSupervisor({
      stateDir,
      deviceId: "d",
      instanceGeneration: "g",
      orphans: t.processes,
      start: async (r: MacWorkerRequest) => {
        await r.beforeLaunch();
        // the launched process: a group leader started just before its launch is recorded
        t.rows.push({
          pid: 66001,
          ppid: 1,
          pgid: 66001,
          startMs: Math.floor(Date.now() / 1000) * 1000,
        });
        await r.onLaunch({ pid: 66001, token: "child" });
        return {
          ready: Promise.resolve(),
          completion: new Promise<typeof result>((r) => {
            finish = r;
          }),
          cancel: async () => {},
        };
      },
    });
    const running = supervisor.execute(
      foreground(stateDir, "op", Date.now() + 30_000),
      "hash",
      signal,
    );
    await vi.waitFor(() => expect(supervisor.ownership().workers).toBe(1));
    await supervisor.settleOrphans();
    expect(t.signals).toEqual([]);
    finish(result);
    expect(await running).toEqual(result);
  });
});
