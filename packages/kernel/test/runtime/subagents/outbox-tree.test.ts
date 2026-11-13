import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../../src/agents/definition.js";
import { ConversationsService } from "../../../src/conversations/conversations.service.js";
import { EventLog } from "../../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import { ConversationQueue } from "../../../src/conversations/queue.service.js";
import { type KernelSchemaDb, kernelDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { OUTBOX_DISPATCH_FAILS } from "../../../src/infra/outbox/outbox.dispatcher.js";
import { OUTBOX_STRICT_CONFLICTS } from "../../../src/infra/outbox/outbox.service.js";
import { RunAbort } from "../../../src/runtime/abort.js";
import { RunFinish } from "../../../src/runtime/run-finish.js";
import {
  ENSURE_RUN_JOB,
  ensureRunJobId,
  RUN_JOB,
  runJobId,
  SUBAGENT_RUN_QUEUE_NAME,
} from "../../../src/runtime/run-jobs.js";
import { forkResultIdemKey, skillCallId } from "../../../src/runtime/subagents/skill-fork.js";
import { SubagentsService } from "../../../src/runtime/subagents/subagents.service.js";
import {
  DELIVER_TO_PARENT_JOB,
  deliverToParentJobId,
  STOP_TREE_JOB,
  stopChildrenJobId,
  stopDeletedTreeJobId,
} from "../../../src/runtime/subagents/tree-jobs.js";
import { MAINTENANCE_QUEUE_NAME } from "../../../src/runtime/waits.js";
import { AGENT_STOPPED_WITH_RUN_TEXT } from "../../../src/tools/builtins/agent.js";
import { truncateTables } from "../../helpers/db.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { accountsFor } from "../../helpers/identity.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import { drainOutbox } from "../../helpers/outbox.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../../helpers/runs.js";
import { runStatus } from "../../helpers/subagents.js";

/**
 * Transactional outbox spec §6 "Sub-agents": a dispatch owes its child run's job in the dispatch
 * transaction; a child run's terminal transaction owes its delivery to the parent
 * (`deliver-to-parent`); a run's terminal transaction writes its open fork invocation's report and
 * owes the stop of its fork child (`stop-tree`); a root's delete owes its tree's stop (`stop-tree`);
 * a transaction that releases a root's hold owes the held sub-agents' ensure-run backstop.
 *
 * Each test commits the owing transaction alone, as a process that died right after the commit
 * would leave it (the production entry where it has no direct follow-up, else the transaction's
 * own method), while every queue add of the kernel's outbox dispatcher fails
 * (`OUTBOX_DISPATCH_FAILS`): what it owed stays in the outbox. The test then asserts the row,
 * turns the adds back on, makes the row due on the database's clock and delivers it with one
 * relay pass (`OutboxDispatcher.dispatchDue`). The sub-agent run queue stays paused unless a test
 * resumes it, so a child runs only when the test lets it.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let subQueue: Queue;
let maint: Queue;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
/** While true, every queue add of the kernel's outbox dispatcher fails. */
let failing = false;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE] }), {
    overrides: [
      { provide: OUTBOX_DISPATCH_FAILS, useValue: () => failing },
      { provide: OUTBOX_STRICT_CONFLICTS, useValue: true },
    ],
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: redis });
  maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redis });
}, 180_000);

afterAll(async () => {
  failing = false;
  await subQueue?.close();
  await maint?.close();
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  failing = false;
  await subQueue.pause();
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox",
  );
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Agent" }]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
  failing = false;
  // a held child job of this test never runs in the next one
  await subQueue.drain(true);
});

/** A `running` parent run of a new conversation (its trigger `seq`), and its step context. */
async function parentRun(opts: { conv?: string; seq?: number; step?: number } = {}) {
  const conv = opts.conv ?? (await createConv(owner, orgId, agentId));
  const runId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: conv,
      status: "running",
      agent_version: 1,
      trigger_account_id: ownerId,
      trigger_seq: opts.seq ?? 0,
    })
    .execute();
  const v = await db
    .selectFrom("agent_versions")
    .select("definition")
    .where("agent_id", "=", agentId)
    .where("version", "=", 1)
    .executeTakeFirstOrThrow();
  const ctx = {
    orgId,
    conversationId: conv,
    runId,
    step: opts.step ?? 1,
    agentId,
    agentVersion: 1,
    agent: normalizeStoredDefinition(v.definition),
    accountId: ownerId,
    signal: new AbortController().signal,
  };
  return { conv, runId, ctx };
}

/** Dispatches a background `Agent` child through the kernel's dispatch (its own deps). */
async function dispatchChild(ctx: Awaited<ReturnType<typeof parentRun>>["ctx"]) {
  const out = await k.app.get(SubagentsService).dispatch({
    ctx,
    callId: "c1",
    input: { description: "Task", prompt: "do the task" },
  });
  if (out.kind !== "dispatched") throw new Error(`not dispatched: ${out.content}`);
  return out;
}

/**
 * A person's fork invocation (its `user_message` with `skill.mode: "fork"`), the `running` run it
 * triggered and the fork child that run dispatched (queued; its job held in the paused queue).
 */
async function forkParent() {
  const conv = await createConv(owner, orgId, agentId);
  const skill = {
    id: randomUUID(),
    version: 1,
    source: "org",
    name: "forky",
    arguments: "go",
    mode: "fork" as const,
  };
  const [msg] = await k.app.get(EventLog).append(conv, [
    {
      type: "user_message",
      payload: {
        content: [{ type: "text", text: "/forky go" }],
        authorAccountId: ownerId,
        skill,
      },
    },
  ]);
  const seq = (msg as ConversationEvent).seq;
  const { runId, ctx } = await parentRun({ conv, seq, step: 0 });
  const out = await k.app.get(SubagentsService).dispatch({
    ctx,
    callId: skillCallId(seq),
    input: { description: "forky", prompt: "go" },
    forSkill: { seq, skill, warnings: [], task: () => "Run the forky skill." },
  });
  if (out.kind !== "dispatched") throw new Error(`not dispatched: ${out.content}`);
  return { conv, runId, seq, childRunId: out.childRunId };
}

/** The owed outbox rows of job `name`, with `run_at` in seconds from now (the PG clock). */
const owed = (name: string) =>
  db
    .selectFrom("outbox")
    .select([
      "queue",
      "job_id",
      "data",
      "org_id",
      sql<number | null>`extract(epoch from run_at - now())::float8`.as("in_seconds"),
    ])
    .where("job_name", "=", name)
    .orderBy("id")
    .execute();

/** Waits until every owed row recorded its fast path's failed attempt (no pass still holds one). */
async function fastPathsFailed(): Promise<void> {
  await waitFor(
    async () => {
      const rows = await db.selectFrom("outbox").select("attempts").execute();
      return rows.length > 0 && rows.every((r) => r.attempts >= 1);
    },
    10_000,
    "the fast paths' failed attempts recorded",
  );
}

/**
 * Redis is back: turns the dispatch seam off, makes the rows of job `name` due now (their backstop
 * delay included) and every row's next attempt due, delivers them with one relay pass and waits
 * until they are gone (the worker's relay may hold some: {@link drainOutbox}).
 */
async function deliver(name: string): Promise<void> {
  await fastPathsFailed();
  failing = false;
  await db.updateTable("outbox").set({ next_attempt_at: sql<Date>`now()` }).execute();
  await db
    .updateTable("outbox")
    .set({ run_at: sql<Date>`now()` })
    .where("job_name", "=", name)
    .execute();
  await drainOutbox(k.app, { jobName: name });
}

/** Expects a backstop row fired about 30 s after its transaction (the database's clock). */
function expectBackstop(row: { in_seconds: number | null } | undefined): void {
  expect(row?.in_seconds).toBeGreaterThan(20);
  expect(row?.in_seconds).toBeLessThanOrEqual(31);
}

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};

const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

const runFinished = {
  type: "run_finished" as const,
  payload: { reason: "completed", consumedUpToSeq: 0 },
};

describe("sub-agent work owed in its transactions", () => {
  it("a dispatched child starts with the fast path disabled", async () => {
    const { ctx } = await parentRun();
    failing = true;
    const out = await dispatchChild(ctx);
    const child = await db
      .selectFrom("runs")
      .select(["status", "trigger_seq"])
      .where("id", "=", out.childRunId)
      .executeTakeFirstOrThrow();
    expect(child.status).toBe("queued");
    const jobId = runJobId(out.childConversationId, Number(child.trigger_seq));
    // the child's job is owed with the dispatch, on the sub-agent run queue
    expect(await owed(RUN_JOB)).toEqual([
      {
        queue: SUBAGENT_RUN_QUEUE_NAME,
        job_id: jobId,
        data: { runId: out.childRunId, conversationId: out.childConversationId },
        org_id: orgId,
        in_seconds: null,
      },
    ]);
    await fastPathsFailed();
    expect(await subQueue.getJob(jobId)).toBeUndefined();
    await deliver(RUN_JOB);
    expect((await subQueue.getJob(jobId))?.data).toEqual({
      runId: out.childRunId,
      conversationId: out.childConversationId,
    });
    await subQueue.resume();
    await waitFor(
      async () => (await runStatus(db, out.childRunId)) === "completed",
      30_000,
      "the child run completed",
    );
  }, 60_000);

  it("a finished child's result reaches its parent with the fast path disabled", async () => {
    const { conv, ctx } = await parentRun();
    const out = await dispatchChild(ctx);
    // the child's run as its worker would leave it: its reply, then its terminal transaction
    await db
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", out.childRunId)
      .execute();
    await k.app.get(EventLog).append(out.childConversationId, [
      {
        type: "assistant_message",
        runId: out.childRunId,
        idemKey: `assistant:${out.childRunId}:by-hand`,
        payload: {
          step: 1,
          content: [{ type: "text", text: "child result" }],
          stopReason: "end_turn",
        },
      },
    ]);
    failing = true;
    // the terminal transaction alone: the worker died before it reported to the parent
    await k.app.get(RunFinish).finish({
      conversationId: out.childConversationId,
      runId: out.childRunId,
      status: "completed",
      consumed: null,
      event: runFinished,
    });
    expect(ofType(await eventsOf(db, conv), "subagent_delivery")).toEqual([]);
    const rows = await owed(DELIVER_TO_PARENT_JOB);
    expect(rows).toEqual([
      {
        queue: MAINTENANCE_QUEUE_NAME,
        job_id: deliverToParentJobId(out.childRunId),
        data: { childRunId: out.childRunId },
        org_id: orgId,
        in_seconds: expect.any(Number),
      },
    ]);
    expectBackstop(rows[0]);
    await deliver(DELIVER_TO_PARENT_JOB);
    const delivery = await waitFor(
      async () => ofType(await eventsOf(db, conv), "subagent_delivery")[0] ?? null,
      15_000,
      "the finished delivery",
    );
    expect(delivery.payload).toMatchObject({
      childRunId: out.childRunId,
      kind: "finished",
      status: "completed",
      text: "child result",
    });
    expect(ofType(await eventsOf(db, conv), "subagent_finished")).toHaveLength(1);
  }, 60_000);

  it("a parent finishing stops its fork child with the fast path disabled", async () => {
    const { conv, runId, childRunId } = await forkParent();
    failing = true;
    // the parent's terminal transaction alone: its worker died before stopping the child
    await k.app.get(RunFinish).finish({
      conversationId: conv,
      runId,
      status: "completed",
      consumed: null,
      event: runFinished,
    });
    const rows = await owed(STOP_TREE_JOB);
    expect(rows).toEqual([
      {
        queue: MAINTENANCE_QUEUE_NAME,
        job_id: stopChildrenJobId(runId),
        data: { runId },
        org_id: orgId,
        in_seconds: expect.any(Number),
      },
    ]);
    expectBackstop(rows[0]);
    expect(await runStatus(db, childRunId)).toBe("queued");
    expect(await k.app.get(RunAbort).requested(childRunId)).toBeNull();
    await deliver(STOP_TREE_JOB);
    // the child's job is held in the paused queue: the stop is its marker, honoured at its start
    await waitFor(
      async () => (await k.app.get(RunAbort).requested(childRunId)) !== null,
      15_000,
      "the fork child asked to stop",
    );
    await subQueue.resume();
    await waitFor(
      async () => (await runStatus(db, childRunId)) === "aborted",
      30_000,
      "the fork child stopped",
    );
  }, 60_000);

  it("deleting a root stops the tree with the fast path disabled", async () => {
    const { conv, runId, ctx } = await parentRun();
    const out = await dispatchChild(ctx);
    // the root's run is over; its background child still waits to run
    await db.updateTable("runs").set({ status: "completed" }).where("id", "=", runId).execute();
    failing = true;
    // the delete's transaction alone: the process died before its direct tree stop
    const conversations = k.app.get(ConversationsService) as unknown as {
      markDeleted(orgId: string, conversationId: string, accountId: string): Promise<void>;
    };
    await conversations.markDeleted(orgId, conv, ownerId);
    const rows = await owed(STOP_TREE_JOB);
    expect(rows).toEqual([
      {
        queue: MAINTENANCE_QUEUE_NAME,
        job_id: stopDeletedTreeJobId(conv),
        data: { conversationId: conv, byAccountId: ownerId },
        org_id: orgId,
        in_seconds: expect.any(Number),
      },
    ]);
    expectBackstop(rows[0]);
    expect(await k.app.get(RunAbort).requested(out.childRunId)).toBeNull();
    await deliver(STOP_TREE_JOB);
    await waitFor(
      async () => (await k.app.get(RunAbort).requested(out.childRunId)) !== null,
      15_000,
      "the tree's child asked to stop",
    );
    await subQueue.resume();
    await waitFor(
      async () => (await runStatus(db, out.childRunId)) === "aborted",
      30_000,
      "the tree's child stopped",
    );
    const aborted = ofType(await eventsOf(db, out.childConversationId), "run_aborted");
    expect(aborted[0]?.payload).toMatchObject({ byAccountId: ownerId });
  }, 60_000);

  it("a parent's terminal transaction leaves no open Agent call", async () => {
    const { conv, runId, seq } = await forkParent();
    // a terminal path that writes no report of its own (an orphan repair, an eval's finish)
    const toSeq = await k.app.get(RunFinish).finish({
      conversationId: conv,
      runId,
      status: "failed",
      consumed: null,
      event: {
        type: "run_failed",
        payload: { error: { code: "run.orphaned", message: "The run was lost" } },
      },
    });
    const events = await eventsOf(db, conv);
    const report = ofType(events, "skill_fork_result");
    expect(report).toHaveLength(1);
    const keyed = await db
      .selectFrom("conversation_events")
      .select("seq")
      .where("conversation_id", "=", conv)
      .where("idem_key", "=", forkResultIdemKey(seq))
      .executeTakeFirst();
    expect(Number(keyed?.seq)).toBe(report[0]?.seq);
    expect(JSON.stringify(report[0]?.payload)).toContain(AGENT_STOPPED_WITH_RUN_TEXT);
    // written in the terminal transaction, before the terminal event
    expect(report[0]?.seq).toBeLessThan(toSeq ?? 0);
  }, 60_000);

  it("a root's unpause owes the wakes it held for its tree", async () => {
    const root = await createConv(owner, orgId, agentId);
    await db
      .updateTable("conversations")
      .set({ queue_paused: true, queue_pause_reason: "run_failed" })
      .where("id", "=", root)
      .execute();
    // an idle sub-agent below the root with a message it never absorbed: held by the pause
    const child = randomUUID();
    await db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: orgId,
        agent_id: agentId,
        account_id: ownerId,
        kind: "subagent",
        parent_conversation_id: root,
        subagent_type: "general-purpose",
        subagent_depth: 1,
      })
      .execute();
    const [msg] = await k.app.get(EventLog).append(child, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: "one more thing" }], authorAccountId: ownerId },
      },
    ]);
    const seq = (msg as ConversationEvent).seq;
    failing = true;
    // the unpause's transaction alone: the process died before its direct `wakeHeldTree`
    const queue = k.app.get(ConversationQueue) as unknown as {
      resumeIn(orgId: string, conversationId: string): Promise<void>;
    };
    await queue.resumeIn(orgId, root);
    const rows = (await owed(ENSURE_RUN_JOB)).filter((r) => r.job_id.includes(child));
    expect(rows).toEqual([
      {
        queue: MAINTENANCE_QUEUE_NAME,
        job_id: ensureRunJobId(child, seq),
        data: { conversationId: child },
        org_id: orgId,
        in_seconds: expect.any(Number),
      },
    ]);
    expectBackstop(rows[0]);
    expect(
      await db.selectFrom("runs").select("id").where("conversation_id", "=", child).execute(),
    ).toEqual([]);
    await deliver(ENSURE_RUN_JOB);
    const run = await waitFor(
      async () =>
        db
          .selectFrom("runs")
          .select(["status", "trigger_seq"])
          .where("conversation_id", "=", child)
          .executeTakeFirst(),
      15_000,
      "the held sub-agent's run",
    );
    expect(Number(run.trigger_seq)).toBe(seq);
  }, 60_000);
});
