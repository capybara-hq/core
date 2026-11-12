import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";
import {
  RUN_QUEUE_NAME,
  RunQueue,
  runJobId,
  SUBAGENT_RUN_QUEUE_NAME,
} from "../../src/runtime/run-queue.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
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
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let runs: Queue;
let api: TestKernel;
let worker: TestKernel | undefined;
let req: Req;
let ownerId: string;
/** While true, every queue add of the api kernel's outbox dispatcher fails. */
let failing = true;

const urls = () => ({ pg: pgc.url, redis: rd.url });

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  api = await startKernel(runConfig(urls(), { roles: ["api"] }), {
    overrides: [{ provide: OUTBOX_DISPATCH_FAILS, useValue: () => failing }],
  });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  runs = new Queue(RUN_QUEUE_NAME, { connection: redis });
}, 180_000);

afterAll(async () => {
  await api?.close();
  await runs?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  failing = true;
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
  }, 60_000);

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
    expect(await owedRows(convId)).toEqual([]);
  }, 60_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);
});
