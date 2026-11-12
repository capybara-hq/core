import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { SCHED_SCAN_JOB, schedFireJobId } from "../../src/schedules/job-ids.js";
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
}, 180_000);

afterAll(async () => {
  await k?.close();
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
});
