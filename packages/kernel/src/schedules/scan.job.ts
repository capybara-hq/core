import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { type EffectiveScheduleSettings, readScheduleSettings } from "./effective-settings.js";
import { oweSchedFire, oweSchedSettleUnfired, SCHED_SCAN_JOB } from "./job-ids.js";
import { pauseTaskIn } from "./pause.js";
import { type ScanStep, scanStep } from "./schedule-math.js";
import { type ScheduledTaskPatch, ScheduledTaskStore } from "./store.js";
import type { ScheduledTask, TaskRun } from "./types.js";

/** Due tasks per scan; what is left waits for the next minute. */
const MAX_TASKS = 2000;

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
 * tick plus the task's jitter (or a `once` task ends, or one past its `expires_at`), and the same
 * transaction owes `sched-fire-<taskRunId>` (transactional outbox spec §8.1), so a written tick is
 * never left unfired and the scan needs no repair of lost fire jobs (a fire delivered too late
 * marks its tick missed itself, `ScheduledTaskFirer`), and the run's unfired settle check (a fire
 * job that failed for good before its claim: the tick is missed, `job-ids.ts`). A task whose stored trigger the schedule
 * math cannot evaluate is paused (`invalid_schedule`) instead of failing the scan; a database
 * error fails the pass (the next minute retries) and pauses nothing.
 */
@Injectable()
export class ScheduledTaskScanJob {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ScheduledTaskStore) private readonly store: ScheduledTaskStore,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
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
      await oweSchedFire(this.outbox, fired.id, task.orgId);
      await oweSchedSettleUnfired(
        this.outbox,
        fired.id,
        task.orgId,
        fired.scheduledFor,
        s.catchUpWindowMinutes,
      );
    }
    return true;
  }

  /** A task the scan cannot advance stops being due: paused with `invalid_schedule`. */
  @Transactional()
  private async quarantine(taskId: string): Promise<void> {
    await pauseTaskIn(this.db, taskId, "invalid_schedule", null);
  }

  /** One due task (see the class); returns the run to fire, if any. */
  private async advance(
    t: KernelSchemaDb,
    task: ScheduledTask,
    now: Date,
    catchUpWindowMinutes: number,
  ): Promise<TaskRun | null> {
    // the schedule math alone may mark the task broken; database errors fail this pass only
    let step: ScanStep;
    try {
      step = scanStep(
        {
          trigger: task.trigger,
          nextRunAt: task.nextRunAt as Date,
          jitterSeconds: task.jitterSeconds,
          expiresAt: task.expiresAt,
        },
        now,
        catchUpWindowMinutes,
      );
    } catch (err) {
      throw new TaskScanFailed(task.id, err);
    }
    if (step.missed !== null) {
      await this.store.insertRun(t, {
        id: randomUUID(),
        taskId: task.id,
        orgId: task.orgId,
        scheduledFor: step.missed,
        trial: false,
        status: "skipped",
        skipReason: "missed",
      });
    }
    let fired: TaskRun | null = null;
    if (step.fire !== null) {
      const run = await this.store.insertRun(t, {
        id: randomUUID(),
        taskId: task.id,
        orgId: task.orgId,
        scheduledFor: step.fire,
        trial: false,
      });
      fired = run ?? null;
    }
    const patch: ScheduledTaskPatch =
      step.end === "done"
        ? { status: "ended", nextRunAt: null }
        : step.end === "expired"
          ? { status: "ended", pauseReason: "expired", nextRunAt: null }
          : { nextRunAt: step.nextRunAt };
    await this.store.updateTask(t, task.id, patch);
    return fired;
  }
}
