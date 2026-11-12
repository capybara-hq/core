import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { ScheduledTaskFirer } from "../../src/schedules/fire.js";
import {
  SCHED_SCAN_JOB,
  SCHED_SETTLE_AFTER_MS,
  SCHED_SETTLE_RECHECK_MS,
  schedFireJobId,
  schedSettleJobId,
  schedSettleUnfiredJobId,
} from "../../src/schedules/job-ids.js";
import { ScheduledTaskScanJob } from "../../src/schedules/scan.job.js";
import { ScheduledTasksService } from "../../src/schedules/scheduled-tasks.service.js";
import { type ScheduledTaskInsert, ScheduledTaskStore } from "../../src/schedules/store.js";
import type { ScheduledTask, TaskRun } from "../../src/schedules/types.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createOrg,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Transactional outbox spec §8.1, §8.2: the transaction that writes a pending task run (the scan's
 * tick, a person's "run now") owes its `sched-fire-<taskRunId>` job on the maintenance queue. The
 * kernel's adds to the maintenance queue fail while `failing` is set (`OUTBOX_DISPATCH_FAILS`): the
 * fast path delivers nothing, so a run that fires got there through the owed row an explicit relay
 * pass (`OutboxDispatcher.dispatchDue`) delivered. The cron scan is stopped: the scans are the
 * test's.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let redis: Redis;
let maintenance: Queue;
let ownerId: string;
let orgId: string;
let agentId: string;
/** While true, the kernel's outbox adds to the maintenance queue fail. */
let failing = true;
const store = new ScheduledTaskStore();
const FIVE_MIN = 5 * 60_000;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }), {
    overrides: [
      {
        provide: OUTBOX_DISPATCH_FAILS,
        useValue: (queue: string) => failing && queue === MAINTENANCE_QUEUE_NAME,
      },
    ],
  });
  k.app.get(SchedulerRegistry).getCronJob(SCHED_SCAN_JOB).stop();
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const req = await session(k, "owner");
  orgId = await createOrg(req);
  agentId = await createAgent(req, orgId);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  maintenance = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redis });
}, 180_000);

afterAll(async () => {
  await k?.close();
  await maintenance?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(() => {
  failing = true;
});

const scanner = () => k.app.get(ScheduledTaskScanJob);

/** A task every 5 minutes in UTC, due at the latest tick. */
async function dueTask(over: Partial<ScheduledTaskInsert> = {}): Promise<ScheduledTask> {
  return store.insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId,
    name: "Digest",
    prompt: "hello",
    trigger: { kind: "cron", expr: "*/5 * * * *", timeZone: "UTC" },
    mode: "new",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: new Date(Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN),
    jitterSeconds: 0,
    expiresAt: null,
    ...over,
  });
}

/** The owed (not dead) fire rows of the task runs given. */
const owedFires = (taskRunIds: readonly string[]) =>
  db
    .selectFrom("outbox")
    .select(["queue", "job_name", "job_id", "data", "org_id"])
    .where("job_name", "=", "sched-fire")
    .where("dead_at", "is", null)
    .where(
      "job_id",
      "in",
      taskRunIds.map((id) => schedFireJobId(id)),
    )
    .execute();

/** Lets the maintenance queue's adds succeed and runs one relay pass over the owed rows. */
async function relay(): Promise<void> {
  failing = false;
  await db
    .updateTable("outbox")
    .set({ next_attempt_at: sql<Date>`now()` as unknown as Date })
    .where("job_name", "=", "sched-fire")
    .execute();
  await k.app.get(OutboxDispatcher).dispatchDue(500);
}

async function runOf(id: string): Promise<TaskRun> {
  const r = await store.updateRun(db, id, {});
  if (!r) throw new Error("no task run");
  return r;
}

const settled = (id: string) =>
  waitFor(
    async () => {
      const r = await runOf(id);
      return r.status !== "pending" && r.status !== "running" && r;
    },
    20_000,
    `task run ${id} settled`,
  );

const conversationsOf = (taskId: string) =>
  db.selectFrom("conversations").select("id").where("scheduled_task_id", "=", taskId).execute();

/** The task run's row is owed exactly once, on the maintenance queue, and nothing fired yet. */
async function expectOwedOnly(run: TaskRun): Promise<void> {
  expect(await owedFires([run.id])).toEqual([
    {
      queue: MAINTENANCE_QUEUE_NAME,
      job_name: "sched-fire",
      job_id: schedFireJobId(run.id),
      data: { taskRunId: run.id },
      org_id: orgId,
    },
  ]);
  expect(await runOf(run.id)).toMatchObject({ status: "pending", firedAt: null });
}

describe("scheduled fires through the outbox", { timeout: 60_000 }, () => {
  it("a scanned tick fires with the fast path disabled", async () => {
    const t = await dueTask();
    await scanner().scanAt(new Date());
    const [run] = await store.listRuns(db, t.id, 10);
    if (!run) throw new Error("the scan wrote no task run");
    await expectOwedOnly(run);

    await relay();
    expect((await settled(run.id)).status).toBe("completed");
    expect(await conversationsOf(t.id)).toHaveLength(1);
    expect(await owedFires([run.id])).toEqual([]);
  });

  it("run-now fires with the fast path disabled", async () => {
    const t = await dueTask({ nextRunAt: new Date(Date.now() + 86_400_000) });
    const run = await k.app.get(ScheduledTasksService).runNow(orgId, ownerId, t.id, {
      trial: false,
    });
    await expectOwedOnly(run);

    await relay();
    expect((await settled(run.id)).status).toBe("completed");
    expect(await conversationsOf(t.id)).toHaveLength(1);
  });

  it("a tick is fired once when the scan runs twice", async () => {
    const t = await dueTask();
    const tick = t.nextRunAt as Date;
    // two replicas' scans at once, then a scan that sees the same tick due again
    await Promise.all([scanner().scanAt(new Date()), scanner().scanAt(new Date())]);
    await store.updateTask(db, t.id, { nextRunAt: tick });
    await scanner().scanAt(new Date());
    const runs = await store.listRuns(db, t.id, 10);
    expect(runs).toHaveLength(1);
    const run = runs[0] as TaskRun;
    await expectOwedOnly(run);

    await relay();
    expect((await settled(run.id)).status).toBe("completed");
    expect(await conversationsOf(t.id)).toHaveLength(1);
  });

  it("a fire delivered after the catch-up window marks its tick missed", async () => {
    const t = await dueTask();
    await scanner().scanAt(new Date());
    const [run] = await store.listRuns(db, t.id, 10);
    if (!run) throw new Error("the scan wrote no task run");
    // the fire is delivered long after its tick (the default window is 60 minutes, plus slack)
    await db
      .updateTable("scheduled_task_runs")
      .set({ scheduled_for: new Date(Date.now() - 2 * 3_600_000) })
      .where("id", "=", run.id)
      .execute();

    await relay();
    expect(await settled(run.id)).toMatchObject({
      status: "skipped",
      skipReason: "missed",
      firedAt: null,
    });
    expect(await conversationsOf(t.id)).toHaveLength(0);
    expect((await store.getTask(db, orgId, t.id))?.status).toBe("active");
  });

  it("a person's late run-now still runs", async () => {
    const t = await dueTask({ nextRunAt: new Date(Date.now() + 86_400_000) });
    const run = await k.app.get(ScheduledTasksService).runNow(orgId, ownerId, t.id, {
      trial: false,
    });
    await db
      .updateTable("scheduled_task_runs")
      .set({ scheduled_for: new Date(Date.now() - 2 * 3_600_000) })
      .where("id", "=", run.id)
      .execute();

    await relay();
    expect((await settled(run.id)).status).toBe("completed");
  });

  describe("the settle checks of a task run (ruling R26)", () => {
    /**
     * The owed settle rows of `taskRunId` (the claimed checks, or with `unfired` the unfired one),
     * with their due time (`run_at`, ms). The kernel computes it on its own (Node) clock, the
     * test's process: bounds are taken with `Date.now()` around the owing call, never against the
     * database's `now()` (a few ms of skew between the two clocks broke them).
     */
    const owedSettles = async (taskRunId: string, unfired = false) =>
      (
        await sql<{ job_id: string; data: unknown; org_id: string; run_at: Date }>`
          SELECT job_id, data, org_id, run_at
          FROM capybara.outbox
          WHERE job_name = 'sched-settle' AND dead_at IS NULL
            AND data ->> 'taskRunId' = ${taskRunId}
            AND (data ? 'unfired') = ${unfired}
          ORDER BY id`.execute(raw)
      ).rows.map((r) => ({ ...r, run_at: new Date(r.run_at).getTime() }));

    /**
     * Makes job `jobId` due now and waits until it is done: an owed row is brought forward and
     * delivered in one relay pass; one the relay already added with its delay (it adds rows due
     * later ahead of time) is promoted in the queue.
     */
    async function deliverNow(jobId: string): Promise<void> {
      failing = false;
      await db
        .updateTable("outbox")
        .set({
          run_at: sql<Date>`now()` as unknown as Date,
          next_attempt_at: sql<Date>`now()` as unknown as Date,
        })
        .where("job_id", "=", jobId)
        .execute();
      await k.app.get(OutboxDispatcher).dispatchDue(500);
      const left = await db
        .selectFrom("outbox")
        .select("id")
        .where("job_id", "=", jobId)
        .where("dead_at", "is", null)
        .execute();
      expect(left).toEqual([]);
      const added = await maintenance.getJob(jobId);
      if (added && (await added.getState()) === "delayed") await added.promote();
      await waitFor(
        async () => (await maintenance.getJob(jobId)) === undefined,
        20_000,
        `${jobId} done`,
      );
    }

    /**
     * Every claim of `taskId`'s runs fails as it writes `fired_at` (its transaction rolls back);
     * returns the undo.
     */
    async function failClaims(taskId: string): Promise<() => Promise<void>> {
      const fn = `fail_claim_${taskId.replaceAll("-", "_")}`;
      await sql
        .raw(`CREATE OR REPLACE FUNCTION capybara.${fn}() RETURNS trigger AS $$
          BEGIN
            IF NEW.task_id = '${taskId}' AND OLD.fired_at IS NULL AND NEW.fired_at IS NOT NULL
              THEN RAISE EXCEPTION 'simulated claim failure'; END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql;
          CREATE TRIGGER ${fn} BEFORE UPDATE ON capybara.scheduled_task_runs
            FOR EACH ROW EXECUTE FUNCTION capybara.${fn}();`)
        .execute(raw);
      return async () => {
        await sql
          .raw(`DROP TRIGGER IF EXISTS ${fn} ON capybara.scheduled_task_runs;
            DROP FUNCTION IF EXISTS capybara.${fn}();`)
          .execute(raw);
      };
    }

    /** The fire job of `taskRunId` fails all three attempts before its claim and is gone. */
    async function fireFailsForGood(taskId: string, taskRunId: string): Promise<void> {
      const restore = await failClaims(taskId);
      try {
        for (let i = 0; i < 3; i++) {
          await expect(k.app.get(ScheduledTaskFirer).fire(taskRunId)).rejects.toThrow(
            /simulated claim failure/,
          );
        }
      } finally {
        await restore();
      }
      // the attempts above were its delivery: its owed row is gone
      await db.deleteFrom("outbox").where("job_id", "=", schedFireJobId(taskRunId)).execute();
      expect(await runOf(taskRunId)).toMatchObject({ status: "pending", firedAt: null });
      expect(await owedSettles(taskRunId)).toEqual([]);
    }

    /** Ten minutes pass: the run's claim moves back and its claimed check `check` runs now. */
    async function settleNow(taskRunId: string, check = 0): Promise<void> {
      await sql`UPDATE capybara.scheduled_task_runs
        SET fired_at = fired_at - interval '11 minutes' WHERE id = ${taskRunId}`.execute(raw);
      await deliverNow(schedSettleJobId(taskRunId, check));
    }

    /** Every start of `taskId`'s new conversations fails (a database error, retried for nothing). */
    async function failStarts(taskId: string): Promise<() => Promise<void>> {
      const fn = `fail_conv_${taskId.replaceAll("-", "_")}`;
      await sql
        .raw(`CREATE OR REPLACE FUNCTION capybara.${fn}() RETURNS trigger AS $$
          BEGIN
            IF NEW.scheduled_task_id = '${taskId}' THEN RAISE EXCEPTION 'simulated start failure'; END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql;
          CREATE TRIGGER ${fn} BEFORE INSERT ON capybara.conversations
            FOR EACH ROW EXECUTE FUNCTION capybara.${fn}();`)
        .execute(raw);
      return async () => {
        await sql
          .raw(`DROP TRIGGER IF EXISTS ${fn} ON capybara.conversations;
            DROP FUNCTION IF EXISTS capybara.${fn}();`)
          .execute(raw);
      };
    }

    it("a claimed run whose start fails for good is released by its settle check", async () => {
      const t = await dueTask();
      await scanner().scanAt(new Date());
      const [run] = await store.listRuns(db, t.id, 10);
      if (!run) throw new Error("the scan wrote no task run");
      const restore = await failStarts(t.id);
      const before = Date.now();
      try {
        // every attempt of the fire job fails at the start; the claim committed before it
        for (let i = 0; i < 3; i++) {
          await expect(k.app.get(ScheduledTaskFirer).fire(run.id)).rejects.toThrow(
            /simulated start failure/,
          );
        }
      } finally {
        await restore();
      }
      const after = Date.now();
      expect((await runOf(run.id)).status).toBe("pending");
      expect((await runOf(run.id)).firedAt).not.toBeNull();
      const [owed, ...more] = await owedSettles(run.id);
      expect(more).toEqual([]);
      expect(owed).toMatchObject({
        job_id: schedSettleJobId(run.id, 0),
        data: { taskRunId: run.id, check: 0 },
        org_id: orgId,
      });
      expect(owed?.run_at).toBeGreaterThanOrEqual(before + SCHED_SETTLE_AFTER_MS);
      expect(owed?.run_at).toBeLessThanOrEqual(after + SCHED_SETTLE_AFTER_MS);

      await settleNow(run.id);
      expect(await runOf(run.id)).toMatchObject({
        status: "skipped",
        skipReason: "removed",
        firedAt: null,
      });
      expect(await owedSettles(run.id)).toEqual([]);
    });

    it("a run that started normally is left as it is by its settle check", async () => {
      const t = await dueTask();
      await scanner().scanAt(new Date());
      const [run] = await store.listRuns(db, t.id, 10);
      if (!run) throw new Error("the scan wrote no task run");
      await k.app.get(ScheduledTaskFirer).fire(run.id);
      const done = await settled(run.id);
      expect(done.status).toBe("completed");

      await settleNow(run.id);
      // only the claim time differs (the test moved it back)
      expect({ ...(await runOf(run.id)), firedAt: null }).toEqual({ ...done, firedAt: null });
      expect(await owedSettles(run.id)).toEqual([]);
      // its unfired check finds it claimed: nothing changes either
      await deliverNow(schedSettleUnfiredJobId(run.id));
      expect({ ...(await runOf(run.id)), firedAt: null }).toEqual({ ...done, firedAt: null });
    });

    it("a tick whose fire job fails for good before its claim is missed, and the next tick fires", async () => {
      const t = await dueTask();
      const tick = t.nextRunAt as Date;
      await scanner().scanAt(new Date());
      const [run] = await store.listRuns(db, t.id, 10);
      if (!run) throw new Error("the scan wrote no task run");
      // owed with the tick, due when the fire job would call the tick missed itself (default
      // window 60 min + 10 min)
      const [unfired, ...more] = await owedSettles(run.id, true);
      expect(more).toEqual([]);
      expect(unfired).toMatchObject({
        job_id: schedSettleUnfiredJobId(run.id),
        data: { taskRunId: run.id, unfired: true },
        org_id: orgId,
      });
      // the tick's own time decides (it is later than ten minutes from now): no clock read
      expect(unfired?.run_at).toBe(tick.getTime() + 70 * 60_000);

      await fireFailsForGood(t.id, run.id);
      await deliverNow(schedSettleUnfiredJobId(run.id));
      expect(await runOf(run.id)).toMatchObject({
        status: "skipped",
        skipReason: "missed",
        firedAt: null,
      });
      expect((await store.getTask(db, orgId, t.id))?.status).toBe("active");

      // the next tick is not held back as an overlap
      failing = true;
      await scanner().scanAt(new Date(Date.now() + FIVE_MIN));
      const next = (await store.listRuns(db, t.id, 10)).find((r) => r.id !== run.id);
      if (!next) throw new Error("the scan wrote no next task run");
      await relay();
      expect((await settled(next.id)).status).toBe("completed");
    });

    it("a run-now whose fire job fails for good before its claim is removed", async () => {
      const t = await dueTask({ nextRunAt: new Date(Date.now() + 86_400_000) });
      const before = Date.now();
      const run = await k.app.get(ScheduledTasksService).runNow(orgId, ownerId, t.id, {
        trial: false,
      });
      const after = Date.now();
      const [unfired] = await owedSettles(run.id, true);
      expect(unfired?.job_id).toBe(schedSettleUnfiredJobId(run.id));
      expect(unfired?.run_at).toBeGreaterThanOrEqual(before + SCHED_SETTLE_AFTER_MS);
      expect(unfired?.run_at).toBeLessThanOrEqual(after + SCHED_SETTLE_AFTER_MS);

      await fireFailsForGood(t.id, run.id);
      await deliverNow(schedSettleUnfiredJobId(run.id));
      expect(await runOf(run.id)).toMatchObject({
        status: "skipped",
        skipReason: "removed",
        firedAt: null,
      });
    });

    it("a once task's last run whose start failed for good ends released, the task ended", async () => {
      const at = new Date(Date.now() - 60_000);
      const t = await dueTask({
        trigger: { kind: "once", at: at.toISOString().slice(0, 19), timeZone: "UTC" },
        nextRunAt: new Date(Math.floor(at.getTime() / 1000) * 1000),
      });
      await scanner().scanAt(new Date());
      expect((await store.getTask(db, orgId, t.id))?.status).toBe("ended");
      const [run] = await store.listRuns(db, t.id, 10);
      if (!run) throw new Error("the scan wrote no task run");
      const restore = await failStarts(t.id);
      try {
        await expect(k.app.get(ScheduledTaskFirer).fire(run.id)).rejects.toThrow(
          /simulated start failure/,
        );
      } finally {
        await restore();
      }

      await settleNow(run.id);
      // as the deleted scan recheck left it
      expect(await runOf(run.id)).toMatchObject({
        status: "skipped",
        skipReason: "removed",
        firedAt: null,
      });
      expect(await store.getTask(db, orgId, t.id)).toMatchObject({
        status: "ended",
        nextRunAt: null,
      });
    });

    it("a run still in flight at its check owes the next one an hour on", async () => {
      const t = await dueTask();
      await scanner().scanAt(new Date());
      const [run] = await store.listRuns(db, t.id, 10);
      if (!run) throw new Error("the scan wrote no task run");
      // claimed, its message posted and not yet taken by a run (as `inFlightIn` sees it)
      const restore = await failStarts(t.id);
      try {
        await expect(k.app.get(ScheduledTaskFirer).fire(run.id)).rejects.toThrow();
      } finally {
        await restore();
      }
      const conv = randomUUID();
      await sql`INSERT INTO capybara.conversations
          (id, org_id, account_id, agent_id, scheduled_task_id, create_request_id, consumed_seq)
        VALUES (${conv}, ${orgId}, ${ownerId}, ${agentId}, ${t.id}, ${run.id}, 0)`.execute(raw);
      await sql`INSERT INTO capybara.conversation_events (conversation_id, seq, type, payload)
        VALUES (${conv}, 1, 'user_message',
          ${JSON.stringify({ content: [], schedule: { taskRunId: run.id } })}::jsonb)`.execute(raw);

      const before = Date.now();
      await settleNow(run.id);
      const after = Date.now();
      expect((await runOf(run.id)).status).toBe("pending");
      const next = await owedSettles(run.id);
      expect(next).toMatchObject([
        { job_id: schedSettleJobId(run.id, 1), data: { taskRunId: run.id, check: 1 } },
      ]);
      expect(next[0]?.run_at).toBeGreaterThanOrEqual(before + SCHED_SETTLE_RECHECK_MS);
      expect(next[0]?.run_at).toBeLessThanOrEqual(after + SCHED_SETTLE_RECHECK_MS);
      // the conversation goes, so the run is released by the next check
      await db.deleteFrom("conversation_events").where("conversation_id", "=", conv).execute();
      await db.deleteFrom("conversations").where("id", "=", conv).execute();
      await settleNow(run.id, 1);
      expect(await runOf(run.id)).toMatchObject({ status: "skipped", skipReason: "removed" });
    });
  });
});
