import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { newTaskId, taskOutputPath } from "../../src/background/launch.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { withOrgScope } from "../../src/infra/database/org-scope.js";
import { RunAbort } from "../../src/runtime/abort.js";
import { compactionProgressKey } from "../../src/runtime/compaction-progress.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";
import { RunQueue } from "../../src/runtime/run-queue.js";
import { RUN_HOOKS, type RunHooks } from "../../src/runtime/run-worker.js";
import { seedQueued } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  eventsOf,
  gate,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Preemption of an idle compact run (idle compaction spec §5.2, plan S2): input that arrives while
 * an idle compact run is active (a message, a queued message, a waking background task finish)
 * ends it as `superseded`. A running one hears the stop through `RunAbort` (the conversation lock
 * is held, so `RunQueue.ensureRun` decides it before its early return); a queued one nobody claimed
 * is ended in the message's own transaction. A manual compact run is never preempted, a summary
 * already written stands, and a person's stop is never relabelled.
 */

const HOOKS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/hooks-probe/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

/** The worker's seams: each test sets the ones it needs. */
const hooks: RunHooks = {};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, HOOKS_PROBE] },
    ),
    { overrides: [{ provide: RUN_HOOKS, useValue: hooks }] },
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrgWithProviders(k, owner);
  agentId = await createAgent(owner, orgId);
  const enabled = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/hooks-probe`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  delete hooks.afterRunRead;
  delete hooks.beforeRelease;
  delete hooks.beforeRunStarted;
  await holdModelCalls(0);
});

/** Holds every model call of the org in its `model.request` hook (stops early when aborted). */
async function holdModelCalls(sleepMs: number): Promise<void> {
  const configured = await owner({
    method: "POST",
    url: "/plugins/hooks-probe/config",
    payload: { orgId, sleepMs, sleepIn: sleepMs > 0 ? ["model.request"] : [] },
  });
  expect(configured.statusCode, configured.body).toBe(200);
}

const ev = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter(
    (e): e is ConversationEvent & { type: T; payload: EventPayload<T> } => e.type === type,
  );

/** A settled conversation of `n` answered turns: what an idle compaction summarizes. */
async function settled(n = 6): Promise<string> {
  const conv = await createConv(owner, orgId, agentId);
  for (let i = 0; i < n; i++) {
    await postMessage(owner, orgId, conv, `echo:turn ${i} ${"words ".repeat(40)}`);
    await waitForTerminal(db, conv, i + 1, 20_000);
  }
  return conv;
}

/** The seq the idle job would be armed at: the latest run's terminal event. */
async function armedSeqOf(conv: string): Promise<number> {
  const last = (await eventsOf(db, conv)).filter((e) => e.type === "run_finished").at(-1);
  if (!last) throw new Error("no finished run");
  return last.seq;
}

async function startIdle(conv: string): Promise<string> {
  const armedSeq = await armedSeqOf(conv);
  const id = await withOrgScope(orgId, () =>
    k.app.get(RunQueue).startIdleCompaction(conv, armedSeq),
  );
  expect(id).not.toBeNull();
  return id as string;
}

const runStatus = (runId: string, status: string) =>
  waitFor(
    async () => {
      const row = await db
        .selectFrom("runs")
        .select("status")
        .where("id", "=", runId)
        .executeTakeFirst();
      return row?.status === status ? row : null;
    },
    30_000,
    `run ${status}`,
  );

/** Waits until a compact run reached its summary call (progress phase `summarizing`). */
const summarizing = (runId: string) =>
  waitFor(
    async () => {
      const r = await redis.get(compactionProgressKey(runId));
      return r !== null && (JSON.parse(r) as { phase: string }).phase === "summarizing" ? r : null;
    },
    20_000,
    "the compaction reached its model call",
  );

/** The runs of a conversation after `afterId` (creation order), once the last one is terminal. */
async function runsAfter(conv: string, afterId: string, n = 1) {
  return waitFor(
    async () => {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "status", "trigger_seq", "compact", "compact_origin"])
        .where("conversation_id", "=", conv)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const i = rows.findIndex((r) => r.id === afterId);
      const later = rows.slice(i + 1);
      return later.length >= n && later.every((r) => r.status === "completed") ? later : null;
    },
    30_000,
    "the runs after the idle run completed",
  );
}

const forRun = (events: ConversationEvent[], runId: string) =>
  events.filter((e) => e.runId === runId);

const supersededOnly = (events: ConversationEvent[], runId: string) =>
  ev(forRun(events, runId), "run_aborted").map((e) => e.payload);

async function conversationRow(conv: string) {
  return db
    .selectFrom("conversations")
    .select(["queue_paused", "tree_stopped_at"])
    .where("id", "=", conv)
    .executeTakeFirstOrThrow();
}

/** The idle run is still running and no stop was requested for it (the input's ensureRun ran). */
async function expectNotPreempted(runId: string): Promise<void> {
  const row = await db
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  expect(row.status).toBe("running");
  expect(await k.app.get(RunAbort).requested(runId)).toBeNull();
}

/** Finishes a background task of `conv` as the poller does (no process: a bare task row). */
async function finishTask(conv: string): Promise<void> {
  const store = k.app.get(BackgroundTaskStore);
  const id = newTaskId();
  const startedAt = new Date(Date.now() - 5_000);
  await store.insert({
    id,
    orgId,
    conversationId: conv,
    sandboxConversationId: conv,
    deviceId: null,
    runId: "run-x",
    callId: "call-x",
    triggerAccountId: ownerId,
    description: `Task ${id}`,
    command: "true",
    sid: "4242",
    outputPath: taskOutputPath(id),
    startedAt,
    deadlineAt: new Date(startedAt.getTime() + 3_600_000),
    sandboxCreatedAt: new Date(),
  });
  const task = await store.get(id);
  if (!task) throw new Error("task row missing");
  expect(
    await k.app
      .get(BackgroundTaskFinisher)
      .finish(task, { status: "completed", exitCode: 0 }, `out of ${id}\n`, false),
  ).toBe(true);
}

describe("idle compaction preemption (idle compaction spec §5.2)", () => {
  it("a message while the idle run is running supersedes it; the message's run follows", async () => {
    const conv = await settled();
    await holdModelCalls(60_000);
    const idle = await startIdle(conv);
    await summarizing(idle);
    await holdModelCalls(0);
    await postMessage(owner, orgId, conv, "echo:after the pause");
    await runStatus(idle, "aborted");
    const [next] = await runsAfter(conv, idle);

    const events = await eventsOf(db, conv);
    expect(supersededOnly(events, idle)).toEqual([{ byAccountId: null, reason: "superseded" }]);
    expect(ev(forRun(events, idle), "compaction_summary")).toEqual([]);
    const message = ev(events, "user_message").at(-1);
    expect(Number(next?.trigger_seq)).toBe(message?.seq);
    expect(next?.compact).toBe(false);
    // the message's run is under the trigger: it compacts nothing inline
    expect(ev(forRun(events, next?.id as string), "compaction_summary")).toEqual([]);
    expect(ev(forRun(events, next?.id as string), "run_finished")).toHaveLength(1);
    expect(await conversationRow(conv)).toEqual({ queue_paused: false, tree_stopped_at: null });
  });

  it("a message while the idle run is still queued ends it in the message's transaction", async () => {
    const conv = await settled();
    const paused = gate();
    let reached!: (runId: string) => void;
    const atRead = new Promise<string>((r) => {
      reached = r;
    });
    let first = true;
    // only the idle run's job stops before its claim; the message's run goes on
    hooks.afterRunRead = async (runId, conversationId) => {
      if (conversationId !== conv || !first) return;
      first = false;
      reached(runId);
      await paused.promise;
    };
    const idle = await startIdle(conv);
    expect(await atRead).toBe(idle);
    try {
      await postMessage(owner, orgId, conv, "echo:before the claim");
      // ended in PG before any worker started it
      expect((await runStatus(idle, "aborted")).status).toBe("aborted");
      const [next] = await runsAfter(conv, idle);
      const events = await eventsOf(db, conv);
      expect(supersededOnly(events, idle)).toEqual([{ byAccountId: null, reason: "superseded" }]);
      expect(ev(forRun(events, idle), "run_started")).toEqual([]);
      expect(Number(next?.trigger_seq)).toBe(ev(events, "user_message").at(-1)?.seq);
    } finally {
      paused.open();
    }
    expect(await conversationRow(conv)).toEqual({ queue_paused: false, tree_stopped_at: null });
  });

  it("a background task finish that wakes the conversation preempts the idle run", async () => {
    const conv = await settled();
    await holdModelCalls(60_000);
    const idle = await startIdle(conv);
    await summarizing(idle);
    await holdModelCalls(0);
    await finishTask(conv);
    await runStatus(idle, "aborted");
    const [next] = await runsAfter(conv, idle);
    const events = await eventsOf(db, conv);
    expect(supersededOnly(events, idle)).toEqual([{ byAccountId: null, reason: "superseded" }]);
    expect(ev(forRun(events, next?.id as string), "run_started")[0]?.payload).toMatchObject({
      trigger: "background_task",
    });
  });

  it("a background task finish inside a wake run's window does not preempt", async () => {
    const conv = await settled();
    // a first finish wakes the conversation: the wake run's window is open for the next minute
    await finishTask(conv);
    await waitForTerminal(db, conv, 7, 20_000);
    await holdModelCalls(3_000);
    const idle = await startIdle(conv);
    await summarizing(idle);
    // the finish's ensureRun runs before finish() returns (after its commit)
    await finishTask(conv);
    await expectNotPreempted(idle);
    await holdModelCalls(0);
    await runStatus(idle, "completed");
    const events = await eventsOf(db, conv);
    expect(ev(forRun(events, idle), "run_aborted")).toEqual([]);
    expect(ev(forRun(events, idle), "compaction_summary")).toHaveLength(1);
  });

  it("an idle run whose boundary is a wake event opens no wake window: a finish preempts it", async () => {
    const conv = await settled();
    await finishTask(conv);
    await waitForTerminal(db, conv, 7, 20_000);
    // the wake run's window is over (moved back in time instead of waiting a minute)
    await db
      .updateTable("runs")
      .set({ created_at: sql<Date>`now() - interval '2 minutes'` })
      .where("conversation_id", "=", conv)
      .execute();
    await holdModelCalls(60_000);
    const idle = await startIdle(conv);
    // the idle run's boundary (the consumed seq) is the wake run's background_task_finished
    const before = await eventsOf(db, conv);
    const idleRow = await db
      .selectFrom("runs")
      .select("trigger_seq")
      .where("id", "=", idle)
      .executeTakeFirstOrThrow();
    expect(before.find((e) => e.seq === Number(idleRow.trigger_seq))?.type).toBe(
      "background_task_finished",
    );
    await summarizing(idle);
    await holdModelCalls(0);
    await finishTask(conv);
    await runStatus(idle, "aborted");
    const [next] = await runsAfter(conv, idle);
    const events = await eventsOf(db, conv);
    expect(supersededOnly(events, idle)).toEqual([{ byAccountId: null, reason: "superseded" }]);
    expect(ev(forRun(events, next?.id as string), "run_started")[0]?.payload).toMatchObject({
      trigger: "background_task",
    });
  });

  it("a message while the idle run holds the lock before its run_started ends it before any model call", async () => {
    const conv = await settled();
    const paused = gate();
    let reached!: (runId: string) => void;
    const atStart = new Promise<string>((r) => {
      reached = r;
    });
    let first = true;
    // the idle run's worker holds the conversation lock; the run is still queued
    hooks.beforeRunStarted = async (runId, conversationId) => {
      if (conversationId !== conv || !first) return;
      first = false;
      reached(runId);
      await paused.promise;
    };
    const idle = await startIdle(conv);
    try {
      expect(await atStart).toBe(idle);
      expect(await k.app.get(ConversationLock).holder(conv)).toBe(idle);
      await postMessage(owner, orgId, conv, "echo:before the start");
      // the stop is stored for the worker to read; the run is not ended from the message's side
      expect(await k.app.get(RunAbort).requested(idle)).toEqual({
        byAccountId: null,
        reason: "superseded",
      });
      const row = await db
        .selectFrom("runs")
        .select("status")
        .where("id", "=", idle)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("queued");
    } finally {
      paused.open();
    }
    await runStatus(idle, "aborted");
    const [next] = await runsAfter(conv, idle);
    const events = await eventsOf(db, conv);
    expect(supersededOnly(events, idle)).toEqual([{ byAccountId: null, reason: "superseded" }]);
    expect(ev(forRun(events, idle), "usage")).toEqual([]);
    expect(ev(forRun(events, idle), "compaction_summary")).toEqual([]);
    expect(await redis.get(compactionProgressKey(idle))).toBeNull();
    expect(Number(next?.trigger_seq)).toBe(ev(events, "user_message").at(-1)?.seq);
    expect(await conversationRow(conv)).toEqual({ queue_paused: false, tree_stopped_at: null });
  });

  it("a queued message preempts and the queue is not paused afterwards", async () => {
    const conv = await settled();
    await holdModelCalls(60_000);
    const idle = await startIdle(conv);
    await summarizing(idle);
    await holdModelCalls(0);
    const queued = await seedQueued(k.app, orgId, conv, ownerId, {
      text: "echo:queued",
      clientMessageId: randomUUID(),
    });
    expect(queued.statusCode, queued.body).toBe(201);
    await runStatus(idle, "aborted");
    await runsAfter(conv, idle);
    const events = await eventsOf(db, conv);
    expect(supersededOnly(events, idle)).toEqual([{ byAccountId: null, reason: "superseded" }]);
    expect(
      ev(events, "user_message").some((e) =>
        e.payload.content.some((b) => b.type === "text" && b.text === "echo:queued"),
      ),
    ).toBe(true);
    expect(await conversationRow(conv)).toEqual({ queue_paused: false, tree_stopped_at: null });
  });

  it("a message while a manual compact run is running does not preempt it", async () => {
    const conv = await settled();
    await holdModelCalls(3_000);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/compact`,
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(202);
    const { runId: manual } = res.json() as { runId: string };
    await summarizing(manual);
    await postMessage(owner, orgId, conv, "echo:during the manual compaction");
    await expectNotPreempted(manual);
    await holdModelCalls(0);
    await runStatus(manual, "completed");
    await runsAfter(conv, manual);
    const events = await eventsOf(db, conv);
    expect(ev(forRun(events, manual), "run_aborted")).toEqual([]);
    expect(ev(forRun(events, manual), "compaction_summary")).toHaveLength(1);
  });

  it("input after the summary was written leaves the summary standing; the message's run follows", async () => {
    const conv = await settled();
    const cont = gate();
    let reached!: (runId: string) => void;
    const atRelease = new Promise<string>((r) => {
      reached = r;
    });
    let first = true;
    // the idle run's terminal state is written and its conversation lock still held
    hooks.beforeRelease = async (runId, conversationId) => {
      if (conversationId !== conv || !first) return;
      first = false;
      reached(runId);
      await cont.promise;
    };
    const idle = await startIdle(conv);
    try {
      expect(await atRelease).toBe(idle);
      expect(await k.app.get(ConversationLock).holder(conv)).toBe(idle);
      await postMessage(owner, orgId, conv, "echo:after the summary");
      // the run is finished: no stop is sent for it
      expect(await k.app.get(RunAbort).requested(idle)).toBeNull();
    } finally {
      cont.open();
    }
    const [next] = await runsAfter(conv, idle);
    const events = await eventsOf(db, conv);
    expect((await runStatus(idle, "completed")).status).toBe("completed");
    expect(ev(forRun(events, idle), "run_aborted")).toEqual([]);
    expect(ev(forRun(events, idle), "compaction_summary")).toHaveLength(1);
    expect(Number(next?.trigger_seq)).toBe(ev(events, "user_message").at(-1)?.seq);
  });

  it("a person's stop already requested is never relabelled superseded", async () => {
    const conv = await settled();
    await holdModelCalls(60_000);
    const idle = await startIdle(conv);
    await summarizing(idle);
    // the person's stop marker is stored; its broadcast has not reached the worker yet
    await redis.set(`capk:run-abort:${idle}`, JSON.stringify({ byAccountId: ownerId }), "EX", 3600);
    await postMessage(owner, orgId, conv, "echo:while stopping");
    // the message's ensureRun has run (its run would follow the idle run): the marker is the person's
    expect(await k.app.get(RunAbort).requested(idle)).toEqual({ byAccountId: ownerId });
    await holdModelCalls(0);
    await k.app.get(RunAbort).request(idle, ownerId);
    await runStatus(idle, "aborted");
    const events = await eventsOf(db, conv);
    expect(ev(forRun(events, idle), "run_aborted").map((e) => e.payload)).toEqual([
      { byAccountId: ownerId, reason: "user" },
    ]);
  });
});
