import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelRequest } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningOperation, RunningOperations } from "../src/activity.js";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import { MacOperationSupervisor } from "../src/exec/operation-supervisor.js";
import type { MacWorkerRequest } from "../src/exec/operation-worker.js";
import { PolicyStore } from "../src/policy-store.js";
import { type StagedOwnerPolicy, serveOperationV3 } from "../src/server-ops.js";

// What the control socket's `running` op lists: the operations executing now, with who asked
// and how they run, never the command, its arguments or its environment.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-activity-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const op = (tag: string, startedAt = "2026-11-19T00:00:00.000Z"): RunningOperation => ({
  tag,
  conversationId: "conv_1",
  accountId: "acc_1",
  isolation: "restricted",
  startedAt,
});

describe("RunningOperations", () => {
  it("lists what began and has not ended, oldest first", () => {
    const running = new RunningOperations();
    running.begin(op("a", "2026-11-19T00:00:01.000Z"));
    running.begin(op("b", "2026-11-19T00:00:02.000Z"));
    expect(running.list().map((o) => o.tag)).toEqual(["a", "b"]);
    running.end("a");
    expect(running.list().map((o) => o.tag)).toEqual(["b"]);
    running.end("b");
    running.end("unknown");
    expect(running.list()).toEqual([]);
  });

  it("two operations with one tag end one at a time", () => {
    const running = new RunningOperations();
    running.begin(op("t"));
    running.begin(op("t"));
    running.end("t");
    expect(running.list()).toHaveLength(1);
    running.end("t");
    expect(running.list()).toHaveLength(0);
  });

  it("lists only the known fields: extra fields given to begin never come out", () => {
    const running = new RunningOperations();
    running.begin({ ...op("t"), command: "echo secret", env: { TOKEN: "x" } } as RunningOperation);
    expect(running.list()).toEqual([op("t")]);
    expect(JSON.stringify(running.list())).not.toContain("secret");
  });
});

const scope = (profile: "approve-for-me" | "full-access") => ({
  operationId: "op_1",
  admitBeforeMs: Date.now() + 60_000,
  deviceId: "d",
  rootConversationId: "conv_1",
  profileRevision: 0,
  ceilingRevision: "c",
  profile,
  actor: { accountId: "acc_1", conversationId: "conv_1" },
  tag: "t1",
  filesystem:
    profile === "full-access"
      ? { kind: "device" }
      : { kind: "scoped", readRoots: ["/work"], writeRoots: ["/work"] },
  network: profile === "full-access" ? { kind: "environment" } : { kind: "none" },
});
const never = new AbortController().signal;
const limits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  network: { kind: "allowlist", hosts: [] },
};
const request = (args: unknown) =>
  ({ type: "req", id: "q", op: "exec", args, deadlineMs: 1000 }) as KernelRequest;

describe("running operations from the operation dispatch", () => {
  const run = async (profile: "approve-for-me" | "full-access", fail = false) => {
    const running = new RunningOperations();
    const owner: StagedOwnerPolicy = {
      store: new PolicyStore(dir),
      report: () => ({}) as never,
      reconcile: async () => {},
      running,
    };
    let during: RunningOperation[] = [];
    const backend = {
      forExecution: () => ({
        operation: async () => ({
          exec: async () => {
            during = running.list();
            if (fail) throw new Error("boom");
            return { stdout: "", stderr: "", exitCode: 0, truncated: false, timedOut: false };
          },
        }),
      }),
    } as unknown as MacOperationBackend;
    const res = await serveOperationV3(
      backend,
      { id: "d" },
      request({
        scope: scope(profile),
        command: "echo $TOKEN",
        env: { TOKEN: "s3cr3t-value" },
        timeoutMs: 100,
        maxOutputBytes: 100,
        limits,
      }),
      new AbortController().signal,
      undefined,
      owner,
    );
    if (!fail) expect(res).toMatchObject({ ok: true });
    return { res, during, after: running.list() };
  };

  it("an exec is listed while it runs, with its actor and isolation, and not after", async () => {
    const { res, during, after } = await run("approve-for-me");
    expect(res).toMatchObject({ ok: true });
    expect(during).toEqual([
      {
        tag: "t1",
        conversationId: "conv_1",
        accountId: "acc_1",
        isolation: "restricted",
        startedAt: expect.any(String),
      },
    ]);
    expect(after).toEqual([]);
  });

  it("running never contains command text", async () => {
    const { during } = await run("full-access");
    expect(during).toMatchObject([{ isolation: "full" }]);
    const text = JSON.stringify(during);
    expect(text).not.toContain("echo");
    expect(text).not.toContain("s3cr3t-value");
  });

  it("a failed exec leaves the list too", async () => {
    const { res, during, after } = await run("approve-for-me", true);
    expect(res).toMatchObject({ ok: false });
    expect(during).toHaveLength(1);
    expect(after).toEqual([]);
  });
});

describe("background tasks in the running operations", () => {
  /** A supervisor whose workers are fakes: each launch waits for `finish` (or a kill). */
  function supervisor(running: RunningOperations) {
    const finishes: (() => void)[] = [];
    const result = {
      exitCode: 0 as number | null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    };
    const sup = new MacOperationSupervisor({
      stateDir: dir,
      deviceId: "d",
      instanceGeneration: "g",
      now: () => 1,
      onLiveEnded: (id) => running.endOperation(id),
      start: async (request: MacWorkerRequest) => {
        await request.beforeLaunch();
        await request.onLaunch({ pid: 123, token: "trusted-child" });
        let finish!: (v: typeof result) => void;
        const completion = new Promise<typeof result>((r) => {
          finish = r;
        });
        finishes.push(() => finish(result));
        return {
          ready: Promise.resolve(),
          completion,
          cancel: async () => finish({ ...result, exitCode: null }),
        };
      },
    });
    return { sup, finishes };
  }
  const bgRequest = (operationId: string) => ({
    managedOutput: { artifactRoot: dir, outputPath: join(dir, `${operationId}.out`) },
    kind: "exec" as const,
    scope: { ...scope("full-access"), operationId, tag: operationId, admitBeforeMs: 1000 },
    grant: {
      full: true,
      readRoots: ["/"],
      writeRoots: ["/"],
      hosts: [],
      deniedReadRoots: [],
      revision: "v",
    },
    args: { command: "sleep 1000", timeoutMs: 1000, maxOutputBytes: 1000 },
    stateDir: dir,
    pythonPath: "/usr/bin/python3",
    runtimeHash: "runtime",
    beforeLaunch: async () => {},
    onLaunch: async () => {},
  });
  const begin = (running: RunningOperations, operationId: string) =>
    running.begin({ ...op(operationId), isolation: "full" }, operationId);

  it("a background task stays after its start answered and leaves when it completes", async () => {
    const running = new RunningOperations();
    const { sup, finishes } = supervisor(running);
    begin(running, "bg1");
    const ref = await sup.start(bgRequest("bg1") as never, "hash", 2000, never);
    expect(await sup.status(ref, never)).toEqual({ state: "running" });
    expect(running.list().map((o) => o.tag)).toEqual(["bg1"]);
    finishes[0]?.();
    await vi.waitFor(() => expect(running.list()).toEqual([]));
  });

  it("a background task leaves when it is killed", async () => {
    const running = new RunningOperations();
    const { sup } = supervisor(running);
    begin(running, "bg2");
    const ref = await sup.start(bgRequest("bg2") as never, "hash", 2000, never);
    expect(running.list()).toHaveLength(1);
    await sup.stop(ref, { graceMs: 0, signal: never });
    await vi.waitFor(() => expect(running.list()).toEqual([]));
  });

  it("the dispatch keeps a started background task only while its status says running", async () => {
    for (const state of ["running", "exited"] as const) {
      const running = new RunningOperations();
      const owner: StagedOwnerPolicy = {
        store: new PolicyStore(dir),
        report: () => ({}) as never,
        reconcile: async () => {},
        running,
      };
      const ref = { id: "bg_1", operationId: "op_1", deviceId: "d", instanceGeneration: "g" };
      const backend = {
        forExecution: () => ({ background: { start: async () => ref } }),
        background: { status: async () => ({ state }) },
      } as unknown as MacOperationBackend;
      await serveOperationV3(
        backend,
        { id: "d" },
        {
          type: "req",
          id: "q",
          op: "backgroundStart",
          args: {
            scope: scope("approve-for-me"),
            command: "sleep 1000",
            timeoutMs: 100,
            maxOutputBytes: 100,
            limits,
            taskId: "task_1",
            outputPath: "/work/out.txt",
            retainUntilMs: Date.now() + 60_000,
          },
          deadlineMs: 1000,
        } as KernelRequest,
        never,
        undefined,
        owner,
      );
      expect(running.list().map((o) => o.tag)).toEqual(state === "running" ? ["t1"] : []);
      // the backend reports the worker's end: it leaves
      running.endOperation("op_1");
      expect(running.list()).toEqual([]);
    }
  });
});
