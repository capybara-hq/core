import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MacOperationSupervisor } from "../src/exec/operation-supervisor.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";
import { shellQuote } from "../src/exec/shared.js";

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
async function fixture(denyCancel: boolean | number = false) {
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
    };
    await writeFile(
      script,
      `import {startMacOperationWorker} from ${JSON.stringify(workerUrl)}; const worker=await startMacOperationWorker({...${JSON.stringify(request)},beforeLaunch:async()=>{},onLaunch:async identity=>process.send({pid:identity.pid}),onRuntimeReady:async identity=>process.send({pid:identity.pid})},new AbortController().signal);await worker.ready;process.send({ready:true});await worker.completion;`,
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
  let gone!: () => void;
  const workerRemoved = new Promise<void>((resolve) => {
    gone = resolve;
  });
  let cancels = 0;
  const supervisor = new MacOperationSupervisor({
    stateDir,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 1,
    onLiveChanged: (live) => {
      if (!live) gone();
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
    await workerRemoved;
    const second = supervisor.stop(ref, { graceMs: 0, signal });
    // Wait behind the second stop's claim in the serialized journal queue.
    await supervisor.settled("op");
    release();
    expect(await Promise.all([first, second])).toEqual([
      { outcome: "stopped" },
      { outcome: "stopped" },
    ]);
    expect(cancels).toBe(1);
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
