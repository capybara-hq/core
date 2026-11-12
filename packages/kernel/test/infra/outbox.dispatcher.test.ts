import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { OUTBOX_BACKOFF, OutboxDispatcher } from "../../src/infra/outbox/outbox.dispatcher.js";
import { outboxFastPath } from "../../src/infra/outbox/outbox.module.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import type { OutboxJobName } from "../../src/infra/outbox/registry.js";
import { KERNEL_QUEUES } from "../../src/infra/queue/queue-names.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { waitFor } from "../helpers/runs.js";

/**
 * Transactional outbox spec §3.3, §3.4: the dispatcher claims outbox rows `FOR UPDATE SKIP
 * LOCKED`, adds their jobs to BullMQ (a future `runAt` as the remaining delay) and deletes them;
 * a failing queue keeps the row with exponential backoff until it is dead at the 20th attempt.
 * The fast path runs detached after the commit (R9), so tests wait for the job to appear.
 */

const TEST_JOB = "outbox-test-job" as OutboxJobName;
const QUEUE = "cap-kernel-maintenance" as const;

let pgc: TestContainer;
let rd: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: the pool has no schema types
let pool: Kysely<any>;
let db: KernelSchemaDb;
let host: TransactionHost;
let kdb: KernelDb;
let redis: Redis;
let queues: Queue[];
let fails = false;
let dispatcher: OutboxDispatcher;
let outbox: OutboxService;

const silent = () => createLogger("error", { write: () => {} });
const maintenance = () => queues[KERNEL_QUEUES.indexOf(QUEUE)] as Queue;

const rows = () =>
  db
    .selectFrom("outbox")
    .select(["id", "job_id", "attempts", "next_attempt_at", "last_error", "dead_at"])
    .orderBy("id")
    .execute();

/** Writes a row the way a business transaction does, without the fast path. */
const insertRow = async (jobId: string, extra: { runAt?: Date } = {}) => {
  const row = await db
    .insertInto("outbox")
    .values({
      queue: QUEUE,
      job_name: TEST_JOB,
      job_id: jobId,
      data: JSON.stringify({ jobId }),
      run_at: extra.runAt ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
};

const jobsIn = async (q: Queue) => q.getJobs(["waiting", "delayed", "active", "completed"]);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  pool = createDb(pgc.url, 5);
  db = kernelDb(pool);
  host = new TransactionHost(pool, silent());
  kdb = new KernelDb(pool, host);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  queues = KERNEL_QUEUES.map((name) => new Queue(name, { connection: redis }));
  const [runs, subRuns, channels, maint, scope, titles, usage, evals] = queues as [
    Queue,
    Queue,
    Queue,
    Queue,
    Queue,
    Queue,
    Queue,
    Queue,
  ];
  dispatcher = new OutboxDispatcher(
    host,
    kdb,
    silent(),
    runs,
    subRuns,
    channels,
    maint,
    scope,
    titles,
    usage,
    evals,
    () => fails,
  );
  outbox = new OutboxService(host, kdb, silent(), outboxFastPath(dispatcher), true);
}, 120_000);

afterAll(async () => {
  await Promise.all((queues ?? []).map((q) => q.close()));
  await redis?.quit();
  await pool?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
}, 120_000);

beforeEach(async () => {
  fails = false;
  await truncateTables(pool, "capybara.outbox");
  await redis.flushall();
});

describe("OutboxDispatcher", () => {
  it("the fast path adds the job and deletes the row after commit", async () => {
    await host.run(() =>
      outbox.add({ queue: QUEUE, name: TEST_JOB, jobId: "fast-1", data: { n: 1 } }),
    );
    const job = await waitFor(() => maintenance().getJob("fast-1"), 5_000, "the job");
    expect(job.name).toBe(TEST_JOB);
    expect(job.data).toEqual({ n: 1 });
    expect(job.opts.attempts).toBe(3);
    await waitFor(async () => (await rows()).length === 0, 5_000, "the row's deletion");
  });

  it("a delayed row is added at once with the remaining delay", async () => {
    const id = await insertRow("delayed-1", { runAt: new Date(Date.now() + 30_000) });
    await dispatcher.dispatchOwn([id]);
    const job = await maintenance().getJob("delayed-1");
    expect(await job?.getState()).toBe("delayed");
    expect(job?.opts.delay).toBeGreaterThanOrEqual(29_000);
    expect(job?.opts.delay).toBeLessThanOrEqual(30_000);
    expect(await rows()).toEqual([]);
  });

  it("a failing queue keeps the row with attempts 1 and next_attempt_at about 1 s ahead", async () => {
    fails = true;
    const id = await insertRow("failing-1");
    const before = Date.now();
    await dispatcher.dispatchOwn([id]);
    const [row] = await rows();
    expect(row).toMatchObject({ job_id: "failing-1", attempts: 1, dead_at: null });
    expect(row?.last_error).toMatch(/dispatch/);
    const ahead = (row as { next_attempt_at: Date }).next_attempt_at.getTime() - before;
    expect(ahead).toBeGreaterThan(500);
    expect(ahead).toBeLessThan(2_500);
    expect(await jobsIn(maintenance())).toEqual([]);
    // not due yet: the relay leaves it
    fails = false;
    expect(await dispatcher.dispatchDue(500)).toEqual({ sent: 0, failed: 0, dead: 0 });
  });

  it("the 20th failure sets dead_at and dispatchDue skips it", async () => {
    await insertRow("dying-1");
    await db
      .updateTable("outbox")
      .set({ attempts: OUTBOX_BACKOFF.maxAttempts - 1 })
      .where("job_id", "=", "dying-1")
      .execute();
    fails = true;
    expect(await dispatcher.dispatchDue(500)).toEqual({ sent: 0, failed: 1, dead: 1 });
    const [row] = await rows();
    expect(row?.attempts).toBe(OUTBOX_BACKOFF.maxAttempts);
    expect(row?.dead_at).toBeInstanceOf(Date);

    fails = false;
    await db
      .updateTable("outbox")
      .set({ next_attempt_at: new Date(0) })
      .execute();
    expect(await dispatcher.dispatchDue(500)).toEqual({ sent: 0, failed: 0, dead: 0 });
    await dispatcher.dispatchOwn([row?.id as string]);
    expect(await rows()).toHaveLength(1);
    expect(await jobsIn(maintenance())).toEqual([]);
  });

  it("fast path and dispatchDue racing for one row add one job", async () => {
    const id = await insertRow("race-1");
    const [, due] = await Promise.all([dispatcher.dispatchOwn([id]), dispatcher.dispatchDue(500)]);
    expect(due.failed).toBe(0);
    expect(await rows()).toEqual([]);
    const jobs = await jobsIn(maintenance());
    expect(jobs.map((j) => j.id)).toEqual(["race-1"]);
  });

  it("a duplicate add after a crash between add and delete is absorbed by the job id", async () => {
    // the state a crash after addBulk and before the delete's commit leaves: the job and the row
    await insertRow("crash-1");
    await maintenance().add(TEST_JOB, { jobId: "crash-1" }, { jobId: "crash-1" });
    expect(await dispatcher.dispatchDue(500)).toEqual({ sent: 1, failed: 0, dead: 0 });
    expect(await rows()).toEqual([]);
    const jobs = await jobsIn(maintenance());
    expect(jobs.map((j) => j.id)).toEqual(["crash-1"]);
  });
});
