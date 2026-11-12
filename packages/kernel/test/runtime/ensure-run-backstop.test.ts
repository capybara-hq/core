import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { newTaskId, taskOutputPath } from "../../src/background/launch.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { OUTBOX_STRICT_CONFLICTS } from "../../src/infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import {
  ENSURE_RUN_FAILS,
  ENSURE_RUN_JOB,
  ensureRunJobId,
  RUN_QUEUE_NAME,
  runJobId,
} from "../../src/runtime/run-queue.js";
import { seedQueued } from "../helpers/conversations.js";
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
 * Transactional outbox spec §6 "Sending a message": every transaction that may start a run after
 * its commit owes an `ensure-run` job on the maintenance queue (`ensure-run-<conv>-<seq>`, 30 s
 * later), and the caller still calls `ensureRun` right after the commit. The api kernel has two
 * seams: `ENSURE_RUN_FAILS` makes that direct call throw (the process died before it, or Redis was
 * unreachable), and `OUTBOX_DISPATCH_FAILS` keeps its fast path from delivering anything, so the
 * owed rows stay in the outbox. The test then asserts the row (its `run_at` about 30 s ahead on the
 * database's clock) and delivers it without waiting 30 s: `run_at` and `next_attempt_at` are set to
 * `now()` in SQL and the relay's pass (`OutboxDispatcher.dispatchDue`) adds the job. A worker
 * kernel (no seams) started only after that runs the maintenance job and the run.
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
}, 180_000);

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

/** The conversation's owed rows of job `name`, with `run_at` in seconds from now (the PG clock). */
const owed = (convId: string, name: string) =>
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
    .where(sql<boolean>`data ->> 'conversationId' = ${convId}`)
    .orderBy("id")
    .execute();

/** Asserts the one ensure-run row the conversation owes for `seq`, due about 30 s from now. */
async function expectEnsureRunOwed(convId: string, orgId: string, seq: number): Promise<void> {
  const rows = await owed(convId, ENSURE_RUN_JOB);
  expect(rows).toEqual([
    {
      queue: MAINTENANCE_QUEUE_NAME,
      job_id: ensureRunJobId(convId, seq),
      data: { conversationId: convId },
      org_id: orgId,
      in_seconds: expect.any(Number),
    },
  ]);
  const secs = rows[0]?.in_seconds ?? 0;
  expect(secs).toBeGreaterThan(20);
  // `run_at` is this process's clock plus 30 s, read against the transaction's `now()`
  expect(secs).toBeLessThanOrEqual(31);
}

/**
 * Redis is back: once every owed row records its fast path's failed attempt (so no fast-path pass
 * still holds a row), turns the dispatch seam off, makes every owed row due now (the ensure-run's
 * 30 s included) and delivers them with the relay's pass.
 */
async function deliverOwed(): Promise<void> {
  await waitFor(
    async () => {
      const rows = await db.selectFrom("outbox").select("attempts").execute();
      return rows.length > 0 && rows.every((r) => r.attempts >= 1);
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
    const seq = await postMessage(req, orgId, convId, "echo:hi");
    // the direct call never happened: no run, but the message's transaction owes the backstop
    expect(await runRows(convId)).toEqual([]);
    await expectEnsureRunOwed(convId, orgId, seq);
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
  }, 60_000);

  it("ensure-run after the direct call already started the run adds nothing", async () => {
    const { orgId, convId } = await setup();
    const seq = await postMessage(req, orgId, convId, "echo:once");
    const [run] = await runRows(convId);
    expect(run?.status).toBe("queued");
    await expectEnsureRunOwed(convId, orgId, seq);
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
  }, 60_000);

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
    await expectEnsureRunOwed(convId, orgId, seq);

    await deliverOwed();
    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    await waitForTerminal(db, convId);
    // the wake run's boundary is the finish
    expect(await runRows(convId)).toEqual([expect.objectContaining({ trigger_seq: String(seq) })]);
    expect(await consumedSeq(db, convId)).toBeGreaterThanOrEqual(seq);
  }, 60_000);

  it("with Redis unreachable the send returns 201 and the run starts after Redis returns", async () => {
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    // Redis is down: the direct ensureRun throws and the fast path delivers nothing
    ensureFails = true;
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
    await expectEnsureRunOwed(convId, orgId, seq);

    // Redis returns: the relay delivers the backstop, which starts the run
    ensureFails = false;
    await deliverOwed();
    worker = await startKernel(runConfig(urls(), { roles: ["worker"] }));
    const [terminal] = await waitForTerminal(db, convId);
    expect(terminal?.type).toBe("run_finished");
    expect(await consumedSeq(db, convId)).toBe(seq);
  }, 60_000);

  it("with Redis unreachable a queued item is added (201) and goes out once ensure-run fires", async () => {
    const { orgId, convId } = await setup();
    ensureFails = true;
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
    await expectEnsureRunOwed(convId, orgId, Number(last_seq));

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
  }, 60_000);
});
