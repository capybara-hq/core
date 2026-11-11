import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { type EffectiveScheduleSettings, readScheduleSettings } from "./effective-settings.js";
import { SCHED_SCAN_JOB, schedFireJob } from "./job-ids.js";
import { pauseTaskIn } from "./pause.js";
import { lockTaskRow, ScheduledTaskRunTracker } from "./run-tracker.js";
import { dueTicks, nextTick } from "./schedule-math.js";
import { type ScheduledTaskPatch, ScheduledTaskStore } from "./store.js";
import type { ScheduledTask } from "./types.js";

/** Due tasks per scan; what is left waits for the next minute. */
const MAX_TASKS = 2000;
/** A pending task run never fired this long after its tick: its fire job is enqueued again. */
const REPAIR_AFTER_MS = 10 * 60_000;
/** ... and this long after its tick it is given up (`skipped`, `missed`). */
const GIVE_UP_AFTER_MS = 60 * 60_000;
const REPAIR_BATCH = 100;

/**
 * The schedule math could not evaluate a due task's stored trigger (its transaction rolled back);
 * the scan pauses it. Only the math raises it: a database error fails the scan pass instead (the
 * next minute retries) and never pauses a healthy task.
 */
class TaskScanFailed extends Error {
  constructor(
    readonly taskId: string,
    cause: unknown,
  ) {
    super(`scheduled task ${taskId} cannot be advanced`, { cause });
  }
}

/**
 * The scheduled task scanner (spec §6), once a minute across replicas. Each due task in its own
 * transaction, locked with `FOR UPDATE SKIP LOCKED` (replicas share the work and never take the
 * same task): the ticks missed outside the org's `catchUpWindowMinutes` become one `skipped` run
 * (`missed`, at the first missed tick), the latest tick in the window gets its run (the unique
 * `(task_id, scheduled_for)` key makes a second insert a no-op), `next_run_at` moves to the next
 * tick plus the task's jitter (or a `once` task ends, or one past its `expires_at`), and after the
 * commit `sched-fire-<taskRunId>` is enqueued. A task whose stored trigger the schedule math cannot
 * evaluate is paused (`invalid_schedule`) instead of failing the scan; a database error fails the
 * pass (the next minute retries) and pauses nothing.
 *
 * Then the repair: a run still `pending` and unfired 10 minutes after its tick has its fire job
 * enqueued again, and is given up (`skipped`, `missed`) after an hour; a run fired an hour ago and
 * still `pending` (its start failed for good) goes through the run tracker's check, which links,
 * settles or releases it, so a `once` task's last run never stays pending.
 */
@Injectable()
export class ScheduledTaskScanJob {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ScheduledTaskStore) private readonly store: ScheduledTaskStore,
    @Inject(ScheduledTaskRunTracker)
    private readonly tracker: Pick<ScheduledTaskRunTracker, "inFlightIn">,
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) private readonly maintenance: Pick<Queue, "add">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  @LockedCron("* * * * *", { name: SCHED_SCAN_JOB })
  async scan(): Promise<void> {
    await this.scanAt(new Date());
  }

  /** One scan as of `now` (tests pass their own); returns how many due tasks it handled. */
  async scanAt(now: Date): Promise<number> {
    const settings = new Map<string, EffectiveScheduleSettings>();
    let total = 0;
    for (; total < MAX_TASKS; total++) {
      try {
        if (!(await this.scanOne(now, settings))) break;
      } catch (err) {
        if (!(err instanceof TaskScanFailed)) throw err;
        // one task that cannot be advanced must not hold the others back every minute
        this.log.error("scheduled task cannot be advanced; paused", {
          taskId: err.taskId,
          err: err.cause,
        });
        await this.quarantine(err.taskId);
      }
    }
    await this.repair(now);
    return total;
  }

  /**
   * One due task in its own transaction (a task whose trigger cannot be evaluated rolls back
   * alone and is paused, so it cannot block the others): locked with `SKIP LOCKED`, so replicas take different tasks. False
   * when no task is due.
   */
  @Transactional()
  private async scanOne(
    now: Date,
    settings: Map<string, EffectiveScheduleSettings>,
  ): Promise<boolean> {
    const t = this.db;
    const [task] = await this.store.lockDue(t, now, 1);
    if (!task) return false;
    let s = settings.get(task.orgId);
    if (s === undefined) {
      s = await readScheduleSettings(t, this.config, task.orgId);
      settings.set(task.orgId, s);
    }
    const fired = await this.advance(t, task, now, s.catchUpWindowMinutes);
    if (fired !== null) {
      const id = fired;
      afterCommit(() => this.enqueue([id]));
    }
    return true;
  }

  /** A task the scan cannot advance stops being due: paused with `invalid_schedule`. */
  @Transactional()
  private async quarantine(taskId: string): Promise<void> {
    await pauseTaskIn(this.db, taskId, "invalid_schedule", null);
  }

  /** One due task (see the class); returns the id of the run to fire, if any. */
  private async advance(
    t: KernelSchemaDb,
    task: ScheduledTask,
    now: Date,
    catchUpWindowMinutes: number,
  ): Promise<string | null> {
    const jitterMs = task.jitterSeconds * 1000;
    // ticks are before jitter: the due tick is next_run_at - jitter, and a tick is due once
    // tick + jitter <= now
    const dueTick = new Date((task.nextRunAt as Date).getTime() - jitterMs);
    const until = new Date(now.getTime() - jitterMs);
    // the schedule math alone may mark the task broken; database errors fail this pass only
    let ticks: ReturnType<typeof dueTicks>;
    let next: Date | null;
    try {
      ticks = dueTicks(task.trigger, new Date(dueTick.getTime() - 1), until, catchUpWindowMinutes);
      next = nextTick(task.trigger, until);
    } catch (err) {
      throw new TaskScanFailed(task.id, err);
    }
    const expires = task.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const fireAt = ticks.fire !== null && ticks.fire.getTime() <= expires ? ticks.fire : null;
    const first = ticks.firstMissed;
    if (first !== null && first.getTime() <= expires) {
      await this.store.insertRun(t, {
        id: randomUUID(),
        taskId: task.id,
        orgId: task.orgId,
        scheduledFor: first,
        trial: false,
        status: "skipped",
        skipReason: "missed",
      });
    }
    let fired: string | null = null;
    if (fireAt !== null) {
      const run = await this.store.insertRun(t, {
        id: randomUUID(),
        taskId: task.id,
        orgId: task.orgId,
        scheduledFor: fireAt,
        trial: false,
      });
      fired = run?.id ?? null;
    }
    const patch: ScheduledTaskPatch =
      next === null
        ? { status: "ended", nextRunAt: null }
        : next.getTime() > expires
          ? { status: "ended", pauseReason: "expired", nextRunAt: null }
          : { nextRunAt: new Date(next.getTime() + jitterMs) };
    await this.store.updateTask(t, task.id, patch);
    return fired;
  }

  /** Enqueues the fire jobs (after the commit; a failure is repaired by a later scan). */
  private async enqueue(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const job = schedFireJob(id);
      try {
        await this.maintenance.add(job.name, job.data, job.opts);
      } catch (err) {
        this.log.warn("enqueueing a scheduled task run failed", { taskRunId: id, err });
      }
    }
  }

  /** Lost fire jobs (see the class). */
  private async repair(now: Date): Promise<void> {
    const stale = await this.db
      .selectFrom("scheduled_task_runs")
      .select(["id", "scheduled_for"])
      .where("status", "=", "pending")
      .where("fired_at", "is", null)
      .where("scheduled_for", "<", new Date(now.getTime() - REPAIR_AFTER_MS))
      .orderBy("scheduled_for")
      .limit(REPAIR_BATCH)
      .execute();
    const retry: string[] = [];
    const lost: string[] = [];
    for (const r of stale) {
      const at = r.scheduled_for instanceof Date ? r.scheduled_for : new Date(r.scheduled_for);
      (now.getTime() - at.getTime() > GIVE_UP_AFTER_MS ? lost : retry).push(r.id);
    }
    for (const id of lost) await this.giveUp(id);
    await this.enqueue(retry);
    // the least recently rechecked first, so runs still in flight do not starve the others
    const started = await this.db
      .selectFrom("scheduled_task_runs")
      .select("id")
      .where("status", "=", "pending")
      .where("fired_at", "<", new Date(now.getTime() - GIVE_UP_AFTER_MS))
      .orderBy(sql`rechecked_at NULLS FIRST`)
      .orderBy("scheduled_for")
      .limit(REPAIR_BATCH)
      .execute();
    for (const r of started) await this.recheck(r.id, now);
  }

  /** A run never fired an hour after its tick: given up, task row first (the one lock order). */
  @Transactional()
  private async giveUp(taskRunId: string): Promise<void> {
    const owner = await this.db
      .selectFrom("scheduled_task_runs")
      .select("task_id")
      .where("id", "=", taskRunId)
      .executeTakeFirst();
    if (!owner) return;
    await lockTaskRow(this.db, owner.task_id);
    await this.db
      .updateTable("scheduled_task_runs")
      .set({ status: "skipped", skip_reason: "missed", error: "The run could not be started" })
      .where("id", "=", taskRunId)
      .where("status", "=", "pending")
      .where("fired_at", "is", null)
      .execute();
  }

  /**
   * A started run still pending long after: the tracker links, settles or releases it; one still
   * in flight is stamped (`rechecked_at`) and goes to the back of the next rechecks.
   */
  @Transactional()
  private async recheck(taskRunId: string, now: Date): Promise<void> {
    const run = await this.store.updateRun(this.db, taskRunId, {});
    if (run?.status !== "pending") return;
    // inFlightIn takes the task row before the run (the one lock order)
    if (await this.tracker.inFlightIn(run, now)) {
      await this.db
        .updateTable("scheduled_task_runs")
        .set({ rechecked_at: now })
        .where("id", "=", taskRunId)
        .execute();
    }
  }
}
