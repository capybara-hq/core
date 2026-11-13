import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { newTaskId, taskOutputPath } from "../../src/background/launch.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { OUTBOX_STRICT_CONFLICTS } from "../../src/infra/outbox/outbox.service.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import {
  ENSURE_RUN_BACKSTOP_MS,
  ENSURE_RUN_FAILS,
  ENSURE_RUN_JOB,
  ensureRunJobId,
  RUN_QUEUE_NAME,
  RunQueue,
  runJobId,
  SUBAGENT_RUN_QUEUE_NAME,
} from "../../src/runtime/run-queue.js";
import { seedQueued } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  consumedSeq,
  createAgent,
  createConv,
  createOrg,
  eventsOf,
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
 * Transactional outbox spec §6 "Starting a run": the run row `ensureRun` creates and its job owed
 * in the outbox commit together, so a queued run always has its job owed. The api kernel's queue
 * adds fail while `failing` is set (the `OUTBOX_DISPATCH_FAILS` seam): its fast path delivers
 * nothing, and the relay's pass (`OutboxDispatcher.dispatchDue`, called directly once the seam is
 * off) is the only delivery. A worker kernel is started only after that, so nothing else adds the
 * job; it runs no relay before then.
 *
 * The same kernel serves "Sending a message" (§6): every transaction that may start a run after its
 * commit owes an `ensure-run` job on the maintenance queue (`ensure-run-<conv>-<seq>`, 30 s later),
 * and the caller still calls `ensureRun` right after the commit. Three seams steer it:
 * `ENSURE_RUN_FAILS` makes that direct call throw (the process died before it, or Redis was
 * unreachable), `OUTBOX_DISPATCH_FAILS` keeps its fast path from delivering anything, and
 * `OUTBOX_STRICT_CONFLICTS` (on) throws on a reused job id with other data.
 * The backstop tests assert the row (its `run_at` about 30 s ahead on the database's clock) and
 * deliver it without waiting 30 s: `run_at` and `next_attempt_at` are set to `now()` in SQL and the
 * relay's pass adds the job. A worker kernel (no seams) started only after that runs the
 * maintenance job and the run.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let runs: Queue;
let maintenance: Queue;
let api: TestKernel;
let worker: TestKernel | undefined;
let req: Req;
let ownerId: string;
/** While true, every queue add of the api kernel's outbox dispatcher fails. */
let failing = true;
/** While true, the api kernel's `RunQueue.ensureRun` throws. */
let ensureFails = false;

const urls = () => ({ pg: pgc.url, redis: rd.url });

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  api = await startKernel(runConfig(urls(), { roles: ["api"] }), {
    overrides: [
      { provide: OUTBOX_DISPATCH_FAILS, useValue: () => failing },
      { provide: ENSURE_RUN_FAILS, useValue: () => ensureFails },
      { provide: OUTBOX_STRICT_CONFLICTS, useValue: true },
    ],
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  runs = new Queue(RUN_QUEUE_NAME, { connection: redis });
  maintenance = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redis });
});

afterAll(async () => {
  await api?.close();
  await runs?.close();
  await maintenance?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  failing = true;
  ensureFails = false;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox",
  );
  await redis.flushdb();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  req = await session(api, "owner");
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
});

async function setup() {
  const orgId = await createOrg(req);
  const agentId = await createAgent(req, orgId);
  const convId = await createConv(req, orgId, agentId);
  return { orgId, agentId, convId };
}

const runRows = (convId: string) =>
  db
    .selectFrom("runs")
    .select(["id", "status", "trigger_seq"])
    .where("conversation_id", "=", convId)
    .orderBy("created_at")
    .execute();

/** The conversation's owed run jobs (its ensure-run backstops are another test's subject). */
const owedRows = (convId: string) =>
  db
    .selectFrom("outbox")
    .select(["queue", "job_name", "job_id", "data", "attempts", "org_id"])
    .where("job_name", "=", "run")
    .where(sql<boolean>`data ->> 'conversationId' = ${convId}`)
    .execute();

/** Moves the run's queue time a minute back (an old queued run). */
const agePastGrace = (runId: string) =>
  db
    .updateTable("runs")
    .set({
      queued_at: sql<Date>`now() - interval '1 minute'`,
      created_at: sql<Date>`now() - interval '1 minute'`,
    })
    .where("id", "=", runId)
    .execute();

/** Waits until every owed row of the conversation records the api kernel's failed fast path. */
async function fastPathFailed(convId: string): Promise<void> {
  await waitFor(
    async () => {
      const rows = await owedRows(convId);
      return rows.length > 0 && rows.every((r) => r.attempts >= 1);
    },
    10_000,
    "the fast path's failed attempt recorded",
  );
}

/** Turns the seam off and delivers the due rows with the relay's pass. */
async function relayPass(): Promise<void> {
  failing = false;
  await db.updateTable("outbox").set({ next_attempt_at: sql<Date>`now()` }).execute();
  await api.app.get(OutboxDispatcher).dispatchDue(500);
}

describe("RunQueue.ensureRun through the outbox", () => {
  it("a message starts its run with the fast path disabled once the relay ticks", async () => {
    const { orgId, convId } = await setup();
    const seq = await postMessage(req, orgId, convId, "echo:hi");
    const [run, ...more] = await runRows(convId);
    expect(more).toEqual([]);
    expect(run).toMatchObject({ status: "queued", trigger_seq: String(seq) });
    const jobId = runJobId(convId, seq);
    // the job is owed in the run's own transaction: one row, with the run's id and org
    await fastPathFailed(convId);
    expect(await owedRows(convId)).toEqual([
      expect.objectContaining({
        queue: RUN_QUEUE_NAME,
        job_name: "run",
        job_id: jobId,
        data: { runId: run?.id, conversationId: convId },
        org_id: orgId,
      }),
    ]);
    expect(await runs.getJob(jobId)).toBeUndefined();

    await relayPass();
    const job = await runs.getJob(jobId);
    expect(job?.data).toEqual({ runId: run?.id, conversationId: convId });
    // a run job keeps its own options: one attempt, removed once done (not the queue defaults)
    expect(job?.opts).toMatchObject({ attempts: 1, removeOnComplete: true, removeOnFail: true });
    expect(await owedRows(convId)).toEqual([]);

    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    const [terminal] = await waitForTerminal(db, convId);
    expect(terminal?.type).toBe("run_finished");
    expect(await consumedSeq(db, convId)).toBe(seq);
  });

  it("two messages within milliseconds start one run and leave no queued row without a job", async () => {
    const { orgId, convId } = await setup();
    const seqs = await Promise.all([
      postMessage(req, orgId, convId, "echo:one"),
      postMessage(req, orgId, convId, "echo:two"),
    ]);
    // both requests' ensureRun ran after their commits: one run, its job owed exactly once
    const rows = await runRows(convId);
    expect(rows).toHaveLength(1);
    const [run] = rows;
    expect(run?.status).toBe("queued");
    await fastPathFailed(convId);
    expect(await owedRows(convId)).toEqual([
      expect.objectContaining({
        job_id: runJobId(convId, Number(run?.trigger_seq)),
        data: { runId: run?.id, conversationId: convId },
      }),
    ]);

    await relayPass();
    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    const newest = Math.max(...seqs);
    await waitFor(async () => (await consumedSeq(db, convId)) >= newest, 15_000, "both consumed");
    await waitFor(
      async () => (await runRows(convId)).every((r) => r.status === "completed"),
      15_000,
      "every run completed",
    );
    const evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.type === "run_failed")).toEqual([]);
    // a later run's job went through the api kernel's fast path: its row is gone once that commits
    await drainOutbox(api.app, { jobName: "run" });
    expect(await owedRows(convId)).toEqual([]);
  });

  it("a queued run whose job the outbox still owes is never stopped as an orphan", async () => {
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "echo:owed");
    const [run] = await runRows(convId);
    expect(run?.status).toBe("queued");
    await fastPathFailed(convId);
    await agePastGrace(run?.id as string);
    // Redis is down: no BullMQ job, but the row is pending, so the stop broadcasts instead
    // (whether such a run lost its job is the run-orphan-check's question)
    expect(await api.app.get(RunQueue).abortIfOrphaned(convId, run?.id as string, null)).toBe(
      false,
    );
    expect(await runRows(convId)).toEqual([expect.objectContaining({ status: "queued" })]);
  });

  it("an old queued run whose job was removed is not failed by a new message", async () => {
    const { orgId, convId } = await setup();
    await postMessage(req, orgId, convId, "echo:first");
    const [run] = await runRows(convId);
    await fastPathFailed(convId);
    // the job is gone (neither owed nor in BullMQ) and the run queued longer than the grace
    await db.deleteFrom("outbox").execute();
    await agePastGrace(run?.id as string);
    await postMessage(req, orgId, convId, "echo:second");
    // ensureRun never treats a queued run as an orphan: the second message waits for it
    expect(await runRows(convId)).toEqual([
      expect.objectContaining({ id: run?.id, status: "queued" }),
    ]);
    const evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.type === "run_failed")).toEqual([]);
  });

  it("a second run of the same trigger gets its own job id, so the earlier run's job never hides it", async () => {
    const { orgId, convId } = await setup();
    const seq = await postMessage(req, orgId, convId, "echo:again");
    const [first] = await runRows(convId);
    await fastPathFailed(convId);
    await relayPass();
    expect(await runs.getJob(runJobId(convId, seq))).toBeDefined();
    // the run ended at its deadline without absorbing its message (R34): the trigger stays
    // unconsumed while BullMQ still holds the first run's job
    await db
      .updateTable("runs")
      .set({ status: "completed", finished_at: sql<Date>`now()` })
      .where("id", "=", first?.id as string)
      .execute();
    failing = true;
    const second = await api.app.get(RunQueue).ensureRun(convId);
    expect(second).not.toBeNull();
    const again = `${runJobId(convId, seq)}-2`;
    const row = await db
      .selectFrom("runs")
      .select(["trigger_seq", "job_id", "status"])
      .where("id", "=", second as string)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ trigger_seq: String(seq), job_id: again, status: "queued" });
    expect(await owedRows(convId)).toEqual([
      expect.objectContaining({ job_id: again, data: { runId: second, conversationId: convId } }),
    ]);
    await fastPathFailed(convId);
    await relayPass();
    expect((await runs.getJob(again))?.data).toEqual({ runId: second, conversationId: convId });
  });

  it("a sub-agent's run started by ensureRun owes its job on the sub-agent queue", async () => {
    const { orgId, agentId, convId } = await setup();
    const child = randomUUID();
    await db
      .insertInto("conversations")
      .values({
        id: child,
        org_id: orgId,
        agent_id: agentId,
        account_id: ownerId,
        title: "Child",
        kind: "subagent",
        source: "subagent",
        parent_conversation_id: convId,
        subagent_type: "general-purpose",
        subagent_depth: 1,
      })
      .execute();
    // a parent's message that reached the idle sub-agent (childWakeIn's pending message)
    const [msg] = await api.app.get(EventLog).append(child, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: "echo:child" }], authorAccountId: ownerId },
      },
    ]);
    const runId = await api.app.get(RunQueue).ensureRun(child);
    expect(runId).not.toBeNull();
    expect(await owedRows(child)).toEqual([
      expect.objectContaining({
        queue: SUBAGENT_RUN_QUEUE_NAME,
        job_name: "run",
        job_id: runJobId(child, msg?.seq as number),
        data: { runId, conversationId: child },
        org_id: orgId,
      }),
    ]);
  });

  it("ensureRun creates no run for a conversation with a live lock holder", async () => {
    const { orgId, convId } = await setup();
    const lease = await api.app.get(ConversationLock).acquire(convId, "someone-else");
    expect(lease).not.toBeNull();
    try {
      await postMessage(req, orgId, convId, "echo:held");
      expect(await runRows(convId)).toEqual([]);
      expect(await owedRows(convId)).toEqual([]);
    } finally {
      await lease?.release();
    }
  });
});

/** The conversation's owed rows of job `name`, with `run_at` in seconds from now (the PG clock). */
const owed = (convId: string, name: string) =>
  db
    .selectFrom("outbox")
    .select(["queue", "job_id", "data", "org_id", "run_at"])
    .where("job_name", "=", name)
    .where(sql<boolean>`data ->> 'conversationId' = ${convId}`)
    .orderBy("id")
    .execute();

/**
 * Asserts the one ensure-run row the conversation owes for `seq`, due
 * {@link ENSURE_RUN_BACKSTOP_MS} after it was owed. `run_at` is the kernel's `Date.now()` plus the
 * backstop, so it is asserted on that one clock: `since` is `Date.now()` taken before the call that
 * owed the row, and the upper bound is `Date.now()` now, after it returned.
 */
async function expectEnsureRunOwed(
  convId: string,
  orgId: string,
  seq: number,
  since: number,
): Promise<void> {
  const until = Date.now();
  const rows = await owed(convId, ENSURE_RUN_JOB);
  expect(rows).toEqual([
    {
      queue: MAINTENANCE_QUEUE_NAME,
      job_id: ensureRunJobId(convId, seq),
      data: { conversationId: convId },
      org_id: orgId,
      run_at: expect.any(Date),
    },
  ]);
  const runAt = rows[0]?.run_at?.getTime() ?? 0;
  expect(runAt).toBeGreaterThanOrEqual(since + ENSURE_RUN_BACKSTOP_MS);
  expect(runAt).toBeLessThanOrEqual(until + ENSURE_RUN_BACKSTOP_MS);
}

/**
 * Redis is back: once every owed row due now records its fast path's failed attempt (so no
 * fast-path pass still holds a row; a delayed row, such as the ensure-run backstop, never goes
 * through the fast path, ruling R20), turns the dispatch seam off, makes every owed row due now
 * (the ensure-run's 30 s included) and delivers them with the relay's pass.
 */
async function deliverOwed(): Promise<void> {
  await waitFor(
    async () => {
      const rows = await db
        .selectFrom("outbox")
        .select(["attempts", sql<boolean>`COALESCE(run_at > now(), false)`.as("delayed")])
        .execute();
      return rows.length > 0 && rows.every((r) => r.attempts >= 1 || r.delayed);
    },
    10_000,
    "the fast paths' failed attempts recorded",
  );
  failing = false;
  await db
    .updateTable("outbox")
    .set({ run_at: sql<Date>`now()`, next_attempt_at: sql<Date>`now()` })
    .execute();
  await api.app.get(OutboxDispatcher).dispatchDue(500);
}

/** Waits until the maintenance job `jobId` ran (ensure-run jobs are removed once done). */
async function maintenanceJobDone(jobId: string): Promise<void> {
  await waitFor(
    async () => (await maintenance.getJob(jobId)) === undefined,
    15_000,
    `maintenance job ${jobId} done`,
  );
}

describe("the ensure-run backstop", () => {
  it("a message whose direct ensureRun is skipped (crash seam) starts its run when ensure-run fires", async () => {
    const { orgId, convId } = await setup();
    ensureFails = true;
    const since = Date.now();
    const seq = await postMessage(req, orgId, convId, "echo:hi");
    // the direct call never happened: no run, but the message's transaction owes the backstop
    expect(await runRows(convId)).toEqual([]);
    await expectEnsureRunOwed(convId, orgId, seq, since);
    expect(await owed(convId, "run")).toEqual([]);

    await deliverOwed();
    const job = await maintenance.getJob(ensureRunJobId(convId, seq));
    expect(job?.name).toBe(ENSURE_RUN_JOB);
    expect(job?.opts).toMatchObject({ removeOnComplete: true, removeOnFail: true });

    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    const [terminal] = await waitForTerminal(db, convId);
    expect(terminal?.type).toBe("run_finished");
    expect(await consumedSeq(db, convId)).toBe(seq);
    const [run, ...more] = await runRows(convId);
    expect(more).toEqual([]);
    expect(run?.trigger_seq).toBe(String(seq));
  });

  it("ensure-run after the direct call already started the run adds nothing", async () => {
    const { orgId, convId } = await setup();
    const since = Date.now();
    const seq = await postMessage(req, orgId, convId, "echo:once");
    const [run] = await runRows(convId);
    expect(run?.status).toBe("queued");
    await expectEnsureRunOwed(convId, orgId, seq, since);
    expect(await owed(convId, "run")).toHaveLength(1);

    // both the run job and the backstop are delivered: the backstop finds the run and does nothing
    await deliverOwed();
    expect(await runs.getJob(runJobId(convId, seq))).toBeDefined();
    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    const [terminal] = await waitForTerminal(db, convId);
    expect(terminal?.type).toBe("run_finished");
    await maintenanceJobDone(ensureRunJobId(convId, seq));
    expect(await runRows(convId)).toEqual([expect.objectContaining({ id: run?.id })]);
    expect(await owed(convId, "run")).toEqual([]);
    const evs = await eventsOf(db, convId);
    expect(evs.filter((e) => e.type === "run_started")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "run_failed")).toEqual([]);
  });

  it("a background task finishing wakes an unwatched chat parent with the direct path skipped", async () => {
    const { orgId, convId } = await setup();
    ensureFails = true;
    const store = api.app.get(BackgroundTaskStore);
    const id = newTaskId();
    const startedAt = new Date(Date.now() - 5_000);
    await store.insert({
      id,
      orgId,
      conversationId: convId,
      sandboxConversationId: convId,
      // a row without a process: no instance to address
      deviceId: null,
      runId: randomUUID(),
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
    // the poller's finish: `BackgroundWake`'s ensureRun after the commit throws (seam)
    const since = Date.now();
    const done = await api.app
      .get(BackgroundTaskFinisher)
      .finish(task, { status: "completed", exitCode: 0 }, "out\n", false);
    expect(done).toBe(true);
    const finished = (await eventsOf(db, convId)).find(
      (e) => e.type === "background_task_finished",
    );
    expect(finished).toBeDefined();
    const seq = finished?.seq ?? 0;
    expect(await runRows(convId)).toEqual([]);
    await expectEnsureRunOwed(convId, orgId, seq, since);

    await deliverOwed();
    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    await waitForTerminal(db, convId);
    // the wake run's boundary is the finish
    expect(await runRows(convId)).toEqual([expect.objectContaining({ trigger_seq: String(seq) })]);
    expect(await consumedSeq(db, convId)).toBeGreaterThanOrEqual(seq);
  });

  it("with Redis unreachable the send returns 201 and the run starts after Redis returns", async () => {
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    // Redis is down: the direct ensureRun throws and the fast path delivers nothing
    ensureFails = true;
    const since = Date.now();
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations`,
      payload: { agentId, message: { text: "echo:first", clientMessageId: randomUUID() } },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { conversation: { id: string }; event: { seq: number } };
    const convId = body.conversation.id;
    const seq = body.event.seq;
    expect(await runRows(convId)).toEqual([]);
    await expectEnsureRunOwed(convId, orgId, seq, since);

    // Redis returns: the relay delivers the backstop, which starts the run
    ensureFails = false;
    await deliverOwed();
    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    const [terminal] = await waitForTerminal(db, convId);
    expect(terminal?.type).toBe("run_finished");
    expect(await consumedSeq(db, convId)).toBe(seq);
  });

  it("with Redis unreachable a queued item is added (201) and goes out once ensure-run fires", async () => {
    const { orgId, convId } = await setup();
    ensureFails = true;
    const since = Date.now();
    const res = await seedQueued(api.app, orgId, convId, ownerId, {
      text: "echo:queued",
      clientMessageId: randomUUID(),
    });
    expect(res.statusCode, res.body).toBe(201);
    // committed, nothing sent: the queue change owes the backstop under the newest seq
    expect(await runRows(convId)).toEqual([]);
    const { last_seq } = await db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", convId)
      .executeTakeFirstOrThrow();
    await expectEnsureRunOwed(convId, orgId, Number(last_seq), since);

    ensureFails = false;
    await deliverOwed();
    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    const [terminal] = await waitForTerminal(db, convId);
    expect(terminal?.type).toBe("run_finished");
    expect(
      await db
        .selectFrom("conversation_queue")
        .select("id")
        .where("conversation_id", "=", convId)
        .execute(),
    ).toEqual([]);
  });
});
