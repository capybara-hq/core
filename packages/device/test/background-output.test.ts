import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  MacOperationSupervisor,
  type SupervisorOptions,
} from "../src/exec/operation-supervisor.js";
import { type MacWorkerRequest, startMacOperationWorker } from "../src/exec/operation-worker.js";
import { shellQuote } from "../src/exec/shared.js";

const signal = new AbortController().signal;
const dirs: string[] = [];
const releases: (() => void)[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  releases.push(release);
  return { promise, release };
}
const result = { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false };
async function fixture(options: Partial<SupervisorOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cap-joined-output-")));
  dirs.push(root);
  let now = 1,
    launches = 0,
    cancels = 0,
    emit: NonNullable<MacWorkerRequest["onOutput"]> = () => {};
  let finish!: (value: typeof result) => void;
  const cancelled = gate();
  let cancellationGate: Promise<void> = Promise.resolve();
  const supervisor = new MacOperationSupervisor({
    stateDir: root,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => now,
    ...options,
    start:
      options.start ??
      (async (request) => {
        launches++;
        emit = request.onOutput ?? (() => {});
        await request.beforeLaunch();
        await request.onLaunch({ pid: 123, token: "owned-test-worker" });
        return {
          ready: Promise.resolve(),
          completion: new Promise<typeof result>((r) => {
            finish = r;
          }),
          cancel: async () => {
            cancels++;
            cancelled.release();
            await cancellationGate;
            finish(result);
          },
        };
      }),
  });
  const request: MacWorkerRequest = {
    kind: "exec",
    scope: {
      operationId: "op",
      admitBeforeMs: 1000,
      deviceId: "d",
      rootConversationId: "r",
      profileRevision: 0,
      ceilingRevision: "c",
      profile: "full-access",
      actor: { accountId: "a", conversationId: "r" },
      tag: "op",
      filesystem: { kind: "device" },
      network: { kind: "environment" },
    },
    grant: {
      full: true,
      readRoots: ["/"],
      writeRoots: ["/"],
      hosts: [],
      deniedReadRoots: [],
      revision: "v",
    },
    stateDir: root,
    pythonPath: "/usr/bin/python3",
    managedOutput: { artifactRoot: root, outputPath: join(root, "task.out") },
    args: { command: "unused", cwd: root, timeoutMs: 10000, maxOutputBytes: 4 },
    beforeLaunch: async () => {},
    onLaunch: async () => {},
  };
  let startedRef: Awaited<ReturnType<MacOperationSupervisor["start"]>> | undefined;
  cleanups.push(async () => {
    if (startedRef) await supervisor.stop(startedRef, { graceMs: 0, signal }).catch(() => {});
    await supervisor.settled("op").catch(() => {});
  });
  return {
    root,
    supervisor,
    request,
    launches: () => launches,
    cancels: () => cancels,
    cancelled: cancelled.promise,
    holdCancel: (p: Promise<void>) => {
      cancellationGate = p;
    },
    emit: async (bytes: Buffer) => {
      await emit(bytes, "stdout");
    },
    finish: () => finish(result),
    expire: () => {
      now = 2001;
    },
    start: async () => {
      startedRef = await supervisor.start(request, "stable", 2000, signal);
      return startedRef;
    },
  };
}
async function all(
  supervisor: MacOperationSupervisor,
  ref: Awaited<ReturnType<MacOperationSupervisor["start"]>>,
) {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const r = await supervisor.readOutput(ref, { offset, maxBytes: 65536, signal });
    if ("unavailable" in r) throw Error(r.unavailable);
    expect(r.offset).toBe(offset);
    expect(r.nextOffset).toBe(offset + r.data.length);
    parts.push(Buffer.from(r.data));
    offset = r.nextOffset;
    if (offset >= r.totalBytes) return Buffer.concat(parts);
  }
}
it("retains 200 KiB disconnected bursts and identical chunks independently of capture limits", async () => {
  const f = await fixture();
  const ref = await f.start();
  const chunk = Buffer.alloc(40960, 65);
  for (let i = 0; i < 5; i++) await f.emit(chunk);
  expect(await all(f.supervisor, ref)).toEqual(Buffer.alloc(204800, 65));
  expect(f.launches()).toBe(1);
  expect(f.cancels()).toBe(0);
  expect(await f.start()).toEqual(ref);
  expect(f.launches()).toBe(1);
  f.finish();
  await f.supervisor.settled("op");
  expect(await readFile(join(f.root, "task.out"))).toEqual(Buffer.alloc(204800, 65));
  expect(await all(f.supervisor, ref)).toEqual(Buffer.alloc(204800, 65));
});
it("final-files-sync-before-complete", async () => {
  const entered = gate(),
    release = gate();
  let block = false;
  const f = await fixture({
    outputBarrier: async (name) => {
      if (block && name === "final-artifact-sync") {
        entered.release();
        await release.promise;
      }
    },
  });
  const ref = await f.start();
  await f.emit(Buffer.from("last"));
  block = true;
  f.finish();
  await entered.promise;
  expect(await f.supervisor.status(ref, signal)).toEqual({ state: "running" });
  expect(await all(f.supervisor, ref)).toEqual(Buffer.from("last"));
  release.release();
  await f.supervisor.settled("op");
  expect(await f.supervisor.status(ref, signal)).toMatchObject({ state: "exited", exitCode: 0 });
});
it.each([false, true])("exit-zero-races-collector-fault (exit first: %s)", async (exitFirst) => {
  const entered = gate(),
    release = gate(),
    cancelRelease = gate();
  let fail = false;
  const f = await fixture({
    outputBarrier: async (name) => {
      if (fail && name === "artifact-write") {
        entered.release();
        await release.promise;
        throw Error("EIO");
      }
    },
  });
  const ref = await f.start();
  await f.emit(Buffer.from("prefix"));
  f.holdCancel(cancelRelease.promise);
  fail = true;
  const append = f.emit(Buffer.from("never-committed"));
  const rejected = expect(append).rejects.toThrow("EIO");
  await entered.promise;
  if (exitFirst) f.finish();
  release.release();
  await rejected;
  if (!exitFirst) f.finish();
  await f.cancelled;
  expect(await f.supervisor.status(ref, signal)).toEqual({ state: "lost" });
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
    outcome: "cancel-pending",
  });
  expect(await all(f.supervisor, ref)).toEqual(Buffer.from("prefix"));
  cancelRelease.release();
  await f.supervisor.settled("op");
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
});
it("mirror-failure-after-child-exit-before-final-flush", async () => {
  const entered = gate(),
    release = gate();
  let fail = false;
  const f = await fixture({
    outputBarrier: async (name) => {
      if (fail && name === "final-artifact-sync") {
        entered.release();
        await release.promise;
        throw Error("EIO");
      }
    },
  });
  const ref = await f.start();
  await f.emit(Buffer.from("verified"));
  fail = true;
  f.finish();
  await entered.promise;
  expect(await f.supervisor.status(ref, signal)).toEqual({ state: "running" });
  release.release();
  await f.cancelled;
  await f.supervisor.settled("op");
  expect(await f.supervisor.status(ref, signal)).toEqual({ state: "lost" });
  expect(await all(f.supervisor, ref)).toEqual(Buffer.from("verified"));
});
it("fault-and-pending-cancel-journal-enospc", async () => {
  let full = false;
  const f = await fixture({
    beforePersist: () => {
      if (full) throw Error("ENOSPC");
    },
  });
  const ref = await f.start();
  await f.emit(Buffer.from("durable"));
  full = true;
  await expect(f.emit(Buffer.from("uncommitted"))).rejects.toThrow("ENOSPC");
  await f.cancelled;
  await f.supervisor.settled("op").catch(() => {});
  expect(f.cancels()).toBe(1);
  expect(await f.supervisor.status(ref, signal)).toEqual({ state: "lost" });
  expect(await all(f.supervisor, ref)).toEqual(Buffer.from("durable"));
  const recovered = new MacOperationSupervisor({
    stateDir: f.root,
    deviceId: "d",
    instanceGeneration: "g",
    now: () => 1,
  });
  expect(await recovered.status(ref, signal)).toEqual({ state: "lost" });
  expect(await all(recovered, ref)).toEqual(Buffer.from("durable"));
  expect(await recovered.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "cancel-pending" });
});
it.each([false, true])(
  "credit-starved-fault-stop-completion-race (stop first: %s)",
  async (stopFirst) => {
    const entered = gate(),
      release = gate(),
      cancelRelease = gate();
    let fail = false;
    const f = await fixture({
      outputBarrier: async (name) => {
        if (fail && name === "spool-write") {
          entered.release();
          await release.promise;
          throw Error("sink failed");
        }
      },
    });
    const ref = await f.start();
    await f.emit(Buffer.from("accepted"));
    f.holdCancel(cancelRelease.promise);
    fail = true;
    const append = f.emit(Buffer.alloc(65536));
    const rejection = expect(append).rejects.toThrow("sink failed");
    await entered.promise;
    let stopping: ReturnType<MacOperationSupervisor["stop"]> | undefined;
    if (stopFirst) {
      stopping = f.supervisor.stop(ref, { graceMs: 0, signal });
      await f.cancelled;
    }
    f.finish();
    release.release();
    await rejection;
    if (!stopFirst) {
      await f.cancelled;
      expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
        outcome: "cancel-pending",
      });
    }
    cancelRelease.release();
    await stopping;
    await f.supervisor.settled("op");
    expect(await f.supervisor.status(ref, signal)).toEqual({ state: "lost" });
    expect(await all(f.supervisor, ref)).toEqual(Buffer.from("accepted"));
    expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
  },
);
it("fault-read-status-stop-race", async () => {
  const entered = gate(),
    release = gate(),
    cancelRelease = gate();
  let pin = false,
    fail = false;
  const f = await fixture({
    outputBarrier: async (name) => {
      if (pin && name === "read") {
        entered.release();
        await release.promise;
      }
      if (fail && name === "artifact-write") throw Error("EIO");
    },
  });
  const ref = await f.start();
  await f.emit(Buffer.from("immutable"));
  pin = true;
  const read = f.supervisor.readOutput(ref, { offset: 0, maxBytes: 65536, signal });
  await entered.promise;
  f.holdCancel(cancelRelease.promise);
  fail = true;
  await expect(f.emit(Buffer.from("bad"))).rejects.toThrow();
  await f.cancelled;
  expect(await f.supervisor.status(ref, signal)).toEqual({ state: "lost" });
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({
    outcome: "cancel-pending",
  });
  f.finish();
  release.release();
  expect(await read).toMatchObject({
    data: Buffer.from("immutable"),
    totalBytes: 9,
    nextOffset: 9,
  });
  cancelRelease.release();
  await f.supervisor.settled("op");
});
it.each(["collecting", "fault", "complete"])(
  "restart-collecting-fault-complete-distinction: %s",
  async (state) => {
    let fail = false;
    const f = await fixture({
      outputBarrier: async (name) => {
        if (fail && name === "spool-write") throw Error("EIO");
      },
    });
    const ref = await f.start();
    await f.emit(Buffer.from("retained"));
    if (state === "complete") {
      f.finish();
      await f.supervisor.settled("op");
    }
    if (state === "fault") {
      fail = true;
      await expect(f.emit(Buffer.from("bad"))).rejects.toThrow();
      await f.cancelled;
      await f.supervisor.settled("op");
    }
    const recovered = new MacOperationSupervisor({
      stateDir: f.root,
      deviceId: "d",
      instanceGeneration: "g",
      now: () => 1,
      start: async () => {
        throw Error("No relaunch");
      },
    });
    expect(await recovered.status(ref, signal)).toMatchObject({
      state: state === "complete" ? "exited" : "lost",
    });
    expect(await all(recovered, ref)).toEqual(Buffer.from("retained"));
    await expect(
      recovered.readOutput(
        { ...ref, instanceGeneration: "next" },
        { offset: 0, maxBytes: 0, signal },
      ),
    ).rejects.toThrow(/generation/);
    if (state === "collecting") {
      expect(await recovered.start(f.request, "stable", 2000, signal)).toEqual(ref);
      expect(await recovered.stop(ref, { graceMs: 0, signal })).toEqual({
        outcome: "cancel-pending",
      });
      f.finish();
      await f.supervisor.settled("op");
    }
  },
);
it("retains 30 terminal lines, split UTF-8, invalid bytes and the 4096-byte overlap budget", async () => {
  const f = await fixture();
  const ref = await f.start();
  const lines = Buffer.from(Array.from({ length: 30 }, (_, i) => `line-${i}\n`).join(""));
  await f.emit(lines);
  f.finish();
  await f.supervisor.settled("op");
  expect(await all(f.supervisor, ref)).toEqual(lines);
  const tail = await f.supervisor.tail(ref, { maxBytes: 65536, signal });
  expect("data" in tail && Buffer.from(tail.data).toString()).toBe(
    Array.from({ length: 20 }, (_, i) => `line-${i + 10}\n`).join(""),
  );
  const g = await fixture();
  const other = await g.start();
  const data = Buffer.concat([
    Buffer.alloc(65534, 97),
    Buffer.from("😀login:123456"),
    Buffer.from([255]),
  ]);
  await g.emit(data.subarray(0, 65536));
  await g.emit(data.subarray(65536));
  const r = await g.supervisor.readOutput(other, { offset: 65536 - 4096, maxBytes: 65536, signal });
  expect("data" in r && r.data).toEqual(data.subarray(61440));
  expect(await all(g.supervisor, other)).toEqual(data);
  g.finish();
  await g.supervisor.settled("op");
});
it.runIf(process.platform === "darwin")(
  "actual macOS worker merges stdout/stderr before capture and retains output past maxOutputBytes",
  async () => {
    const f = await fixture({ start: startMacOperationWorker, now: () => 1 });
    if (f.request.kind !== "exec") throw Error("Expected exec");
    const source = "import os; [(os.write(1,b'A'*40960),os.write(2,b'B'*40960)) for _ in range(3)]";
    f.request.args = { ...f.request.args, command: `/usr/bin/python3 -I -c ${shellQuote(source)}` };
    const ref = await f.start();
    await f.supervisor.settled("op");
    const expected = Buffer.concat(
      Array.from({ length: 3 }, () =>
        Buffer.concat([Buffer.alloc(40960, 65), Buffer.alloc(40960, 66)]),
      ),
    );
    expect(await all(f.supervisor, ref)).toEqual(expected);
    expect(await readFile(join(f.root, "task.out"))).toEqual(expected);
    expect(await f.supervisor.status(ref, signal)).toEqual({
      state: "exited",
      exitCode: 0,
      timedOut: false,
    });
  },
);

it.runIf(process.platform === "darwin").each([false, true])(
  "actual macOS credit-starved control and terminal delivery bypass the paused sink (fault: %s)",
  async (fault) => {
    const entered = gate(),
      release = gate(),
      control = gate(),
      exit = gate();
    let block = true;
    const f = await fixture({
      start: startMacOperationWorker,
      outputBarrier: async (name) => {
        if (block && name === "spool-write") {
          entered.release();
          await release.promise;
          if (fault) throw Error("owned sink fault");
        }
      },
    });
    if (f.request.kind !== "exec") throw Error("Expected exec");
    const flows: { frameBytes: number; bufferedBytes: number; producerLimit: number }[] = [];
    f.request.onOutputFlow = (info) => {
      flows.push(info);
    };
    f.request.onControl = (event) => {
      if (event === "cancelled") control.release();
      else exit.release();
    };
    const source = "import os,signal; os.write(1,b'x'*204800); signal.pause()";
    f.request.args = { ...f.request.args, command: `/usr/bin/python3 -I -c ${shellQuote(source)}` };
    const ref = await f.start();
    await entered.promise;
    const stopping = f.supervisor.stop(ref, { graceMs: 0, signal });
    await control.promise;
    await exit.promise;
    expect(flows).toHaveLength(1);
    expect(flows[0]?.frameBytes).toBeLessThanOrEqual(65536);
    expect(flows[0]?.bufferedBytes).toBeLessThanOrEqual(262144);
    expect(await f.supervisor.readOutput(ref, { offset: 0, maxBytes: 0, signal })).toMatchObject({
      totalBytes: 0,
    });
    block = false;
    release.release();
    expect(await stopping).toEqual({ outcome: "stopped" });
    await f.supervisor.settled("op").catch(() => {});
    expect(await f.supervisor.status(ref, signal)).toMatchObject({
      state: fault ? "lost" : "exited",
    });
    const bytes = await all(f.supervisor, ref);
    if (fault) expect(bytes.length).toBe(0);
    else {
      expect(bytes.length).toBeGreaterThanOrEqual(65536);
      expect(bytes.length).toBeLessThanOrEqual(204800);
      expect(bytes).toEqual(Buffer.alloc(bytes.length, 120));
    }
    expect(await readFile(join(f.root, "task.out"))).toEqual(fault ? expect.any(Buffer) : bytes);
  },
);

it("expiry/cancel retains the operation and pending cancellation tombstones", async () => {
  const f = await fixture();
  const ref = await f.start();
  await f.emit(Buffer.from("owned"));
  const released = gate();
  f.holdCancel(released.promise);
  const stopping = f.supervisor.stop(ref, { graceMs: 0, signal });
  await f.cancelled;
  f.expire();
  await f.supervisor.expireOutput(ref);
  expect(await readFile(join(f.root, "task.out"), "utf8")).toBe("owned");
  expect(await f.supervisor.readOutput(ref, { offset: 0, maxBytes: 0, signal })).toEqual({
    unavailable: "expired",
  });
  released.release();
  await stopping;
  await f.supervisor.expireOutput(ref);
  expect(await f.supervisor.stop(ref, { graceMs: 0, signal })).toEqual({ outcome: "stopped" });
  await expect(f.start()).rejects.toThrow();
  expect(await readFile(join(f.root, "task.out"), "utf8")).toBe("owned");
});

it("supervisor expiry waits for an admitted completed-prefix reader", async () => {
  const entered = gate(),
    release = gate(),
    unlink = gate();
  let block = false;
  const f = await fixture({
    outputBarrier: async (name) => {
      if (block && name === "read") {
        entered.release();
        await release.promise;
      }
      if (name === "expiry-unlink") unlink.release();
    },
  });
  const ref = await f.start();
  await f.emit(Buffer.from("snapshot"));
  f.finish();
  await f.supervisor.settled("op");
  block = true;
  const reading = f.supervisor.readOutput(ref, { offset: 0, maxBytes: 8, signal });
  await entered.promise;
  f.expire();
  let removed = false;
  void unlink.promise.then(() => {
    removed = true;
  });
  const expiry = f.supervisor.expireOutput(ref);
  await Promise.resolve();
  expect(removed).toBe(false);
  release.release();
  expect(await reading).toMatchObject({ data: Buffer.from("snapshot"), totalBytes: 8 });
  await expiry;
  expect(removed).toBe(true);
});

it("a failed completion checkpoint latches fault before waiting for pinned readers", async () => {
  const entered = gate(),
    release = gate(),
    failed = gate();
  let block = false,
    full = false;
  const f = await fixture({
    outputBarrier: async (name) => {
      if (block && name === "read") {
        entered.release();
        await release.promise;
      }
    },
    beforePersist: () => {
      if (full) {
        failed.release();
        throw Error("ENOSPC");
      }
    },
  });
  const ref = await f.start();
  await f.emit(Buffer.from("prefix"));
  block = true;
  const reading = f.supervisor.readOutput(ref, { offset: 0, maxBytes: 6, signal });
  await entered.promise;
  full = true;
  f.finish();
  await failed.promise;
  expect(await f.supervisor.status(ref, signal)).toEqual({ state: "lost" });
  release.release();
  expect(await reading).toMatchObject({ data: Buffer.from("prefix") });
  await f.supervisor.settled("op").catch(() => {});
  await f.cancelled;
});

it.each(["spool-file-sync", "artifact-file-sync", "directory-sync:0", "creation-verify"])(
  "creation-sync-before-locator-and-launch prevents worker dispatch at failed %s",
  async (boundary) => {
    const f = await fixture({
      outputBarrier: async (name) => {
        if (name === boundary) throw Error("creation failed");
      },
    });
    await expect(f.start()).rejects.toThrow("creation failed");
    expect(f.launches()).toBe(0);
  },
);

it.runIf(process.platform === "darwin")(
  "ordinary authorized native Read sees the artifact while narrowed profiles keep exact-ref output access",
  async () => {
    const { createMacOperationBackend } = await import("../src/exec/mac-operation-backend.js");
    const f = await fixture();
    if (f.request.kind !== "exec") throw Error("Expected exec");
    const finished = gate();
    let fullAccess = true,
      ceilingReads = 0;
    const backend = await createMacOperationBackend(
      {
        deviceId: "d",
        instanceGeneration: "actual",
        stateDir: f.root,
        roots: { workspace: f.root, tmp: f.root, skills: f.root },
        pythonPath: "/usr/bin/python3",
        readOwnerCeiling: async () => {
          ceilingReads++;
          return {
            revision: "one",
            fullAccess,
            roots: { workspace: f.root, tmp: f.root, skills: f.root },
            restrictedProjectReach: "os-user",
            restrictedAllowedDomains: [],
            restrictedDeniedReadRoots: [],
            preparation: { skillsRoot: f.root, attachmentsBase: join(f.root, "attachments") },
            fullNetwork: "environment",
          };
        },
      },
      {
        startWorker: startMacOperationWorker,
        platform: "darwin",
        now: () => 1,
        watch: () => () => finished.release(),
      },
    );
    const path = join(f.root, "ordinary.out");
    const ref = await backend.background.start({ id: "d" }, f.request.scope, {
      command: "printf 'ordinary artifact'",
      cwd: f.root,
      timeoutMs: 10000,
      maxOutputBytes: 4,
      signal,
      taskId: "ordinary",
      outputPath: path,
      retainUntilMs: 2000,
    });
    await finished.promise;
    const native = await backend.operation(
      { id: "d" },
      { ...f.request.scope, operationId: "native-read" },
      signal,
    );
    const read = await native.readFile(path, { maxBytes: 65536, signal });
    expect(read?.data).toEqual(Buffer.from("ordinary artifact"));
    fullAccess = false;
    const calls = ceilingReads;
    expect(
      await backend.background.readOutput({ id: "d" }, ref, { offset: 0, maxBytes: 65536, signal }),
    ).toMatchObject({ data: Buffer.from("ordinary artifact"), totalBytes: 17 });
    expect(ceilingReads).toBe(calls);
    const narrowed = await backend.operation(
      { id: "d" },
      { ...f.request.scope, operationId: "narrowed-read" },
      signal,
    );
    await expect(narrowed.readFile(path, { maxBytes: 65536, signal })).rejects.toThrow();
  },
);
