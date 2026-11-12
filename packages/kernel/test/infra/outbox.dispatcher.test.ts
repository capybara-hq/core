import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { ModuleRef } from "@nestjs/core";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import {
  OUTBOX_BACKOFF,
  OUTBOX_FAST_PATH_CONCURRENCY,
  OUTBOX_REDIS_TIMEOUT_MS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { outboxFastPath } from "../../src/infra/outbox/outbox.module.js";
import { OutboxService } from "../../src/infra/outbox/outbox.service.js";
import type { OutboxJobName } from "../../src/infra/outbox/registry.js";
import { KERNEL_QUEUES, type KernelQueueName } from "../../src/infra/queue/queue-names.js";
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
const insertRow = async (jobId: string, extra: { runAt?: Date; queue?: KernelQueueName } = {}) => {
  const row = await db
    .insertInto("outbox")
    .values({
      queue: extra.queue ?? QUEUE,
      job_name: TEST_JOB,
      job_id: jobId,
      data: JSON.stringify({ jobId }),
      run_at: extra.runAt ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
};

/**
 * The database clock as text (microseconds kept): backoff is set from PG `now()`, so it is
 * asserted against PG time only, never against the test process's clock.
 */
const dbClock = async () =>
  (
    (await sql<{ t: string }>`select clock_timestamp()::text as t`.execute(pool)).rows[0] as {
      t: string;
    }
  ).t;

const jobsIn = async (q: Queue) => q.getJobs(["waiting", "delayed", "active", "completed"]);

/**
 * A dispatcher over the given queue handles, in `KERNEL_QUEUES` order (an absent one: no module of
 * this process registered that queue), resolved through a stand-in for Nest's `ModuleRef`.
 */
const dispatcherOver = (qs: readonly (Queue | undefined)[], dispatchFails: () => boolean) => {
  const byToken = new Map<string, Queue>();
  KERNEL_QUEUES.forEach((name, i) => {
    const q = qs[i];
    if (q) byToken.set(getQueueToken(name), q);
  });
  const moduleRef = {
    get: (token: string) => {
      const q = byToken.get(token);
      if (!q) throw new Error(`Nest could not find ${token} element`);
      return q;
    },
  } as unknown as Pick<ModuleRef, "get">;
  return new OutboxDispatcher(host, kdb, silent(), moduleRef, dispatchFails);
};

/** A queue handle without Redis: `client` is what its backend's client promise gives. */
const fakeQueue = (
  addBulk: (jobs: unknown[]) => Promise<unknown> = async () => [],
  client: Promise<{ status: string }> = Promise.resolve({ status: "ready" }),
) => {
  const add = vi.fn(addBulk);
  return { queue: { addBulk: add, getBackend: () => ({ client }) } as unknown as Queue, add };
};

/**
 * A dispatcher whose queues are all fakes, with `over` in place of the named ones (`null`: the
 * queue's owner is not loaded in this process).
 */
const fakeDispatcher = (over: Partial<Record<KernelQueueName, Queue | null>>) =>
  dispatcherOver(
    KERNEL_QUEUES.map((name) => {
      const q = over[name];
      return q === null ? undefined : (q ?? fakeQueue().queue);
    }),
    () => false,
  );

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
  dispatcher = dispatcherOver(queues, () => fails);
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
    const before = await dbClock();
    await dispatcher.dispatchOwn([id]);
    const after = await dbClock();
    const [row] = await rows();
    expect(row).toMatchObject({ job_id: "failing-1", attempts: 1, dead_at: null });
    expect(row?.last_error).toMatch(/dispatch/);
    // exactly baseMs after the failure update's now(), which lies between the two clock reads
    const placed = await sql<{ lower: boolean; upper: boolean }>`
      select next_attempt_at >= ${before}::timestamptz + interval '1 second' as lower,
             next_attempt_at <= ${after}::timestamptz + interval '1 second' as upper
      from capybara.outbox where id = ${id}`.execute(pool);
    expect(OUTBOX_BACKOFF.baseMs).toBe(1000);
    expect(placed.rows).toEqual([{ lower: true, upper: true }]);
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

  it("a fast path with Redis not ready skips the claim and leaves the row", async () => {
    // a connection that never came up: its client promise never settles
    const down = fakeQueue(undefined, new Promise(() => {}));
    const d = fakeDispatcher({ [QUEUE]: down.queue });
    const id = await insertRow("down-1");
    const before = await rows();
    await d.dispatchOwn([id]);
    expect(down.add).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
    expect(before[0]).toMatchObject({ attempts: 0, last_error: null });
    // a connection that dropped (reconnecting) counts as not ready too
    const dropped = fakeQueue(undefined, Promise.resolve({ status: "reconnecting" }));
    await fakeDispatcher({ "cap-kernel-runs": dropped.queue }).dispatchOwn([id]);
    expect(await rows()).toEqual(before);
  });

  it("a first-group timeout marks later groups failed without waiting for them", async () => {
    const hung = fakeQueue(() => new Promise(() => {}));
    const later = fakeQueue();
    const d = fakeDispatcher({ "cap-kernel-runs": hung.queue, [QUEUE]: later.queue });
    await insertRow("hung-1", { queue: "cap-kernel-runs" });
    await insertRow("later-1");
    const start = Date.now();
    expect(await d.dispatchDue(500)).toEqual({ sent: 0, failed: 2, dead: 0 });
    const took = Date.now() - start;
    expect(took).toBeGreaterThanOrEqual(OUTBOX_REDIS_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(OUTBOX_REDIS_TIMEOUT_MS + 1_000);
    expect(hung.add).toHaveBeenCalledTimes(1);
    expect(later.add).not.toHaveBeenCalled();
    const [first, second] = await rows();
    expect(first).toMatchObject({ job_id: "hung-1", attempts: 1 });
    expect(first?.last_error).toMatch(/timed out/);
    expect(second).toMatchObject({ job_id: "later-1", attempts: 1 });
    expect(second?.last_error).toMatch(/^not tried after an earlier queue failed/);
  });

  it("a 5th concurrent fast path is skipped", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = fakeQueue(async () => {
      await gate;
      return [];
    });
    const d = fakeDispatcher({ [QUEUE]: slow.queue });
    const ids: string[] = [];
    for (let i = 0; i <= OUTBOX_FAST_PATH_CONCURRENCY; i++) ids.push(await insertRow(`busy-${i}`));
    const running = ids.slice(0, OUTBOX_FAST_PATH_CONCURRENCY).map((id) => d.dispatchOwn([id]));
    await waitFor(
      async () => slow.add.mock.calls.length === OUTBOX_FAST_PATH_CONCURRENCY,
      5_000,
      "four passes in addBulk",
    );
    await d.dispatchOwn([ids[OUTBOX_FAST_PATH_CONCURRENCY] as string]);
    expect(slow.add).toHaveBeenCalledTimes(OUTBOX_FAST_PATH_CONCURRENCY);
    release();
    await Promise.all(running);
    expect(await rows()).toMatchObject([{ job_id: "busy-4", attempts: 0, last_error: null }]);
  });

  it("a process without a queue's owner leaves that queue's rows untouched", async () => {
    const maint = fakeQueue();
    const d = fakeDispatcher({ "cap-kernel-runs": null, [QUEUE]: maint.queue });
    const elsewhere = await insertRow("elsewhere-1", { queue: "cap-kernel-runs" });
    const here = await insertRow("here-1");
    await d.dispatchOwn([elsewhere, here]);
    expect(maint.add).toHaveBeenCalledTimes(1);
    expect(await rows()).toMatchObject([
      { job_id: "elsewhere-1", attempts: 0, last_error: null, dead_at: null },
    ]);
    expect(await d.dispatchDue(500)).toEqual({ sent: 0, failed: 0, dead: 0 });
    expect(await rows()).toMatchObject([{ job_id: "elsewhere-1", attempts: 0, last_error: null }]);
  });
});
