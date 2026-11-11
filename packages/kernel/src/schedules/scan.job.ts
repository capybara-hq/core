import { randomUUID } from "node:crypto";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
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
import { dueTicks, nextTick } from "./schedule-math.js";
import { type ScheduledTaskPatch, ScheduledTaskStore } from "./store.js";
import type { ScheduledTask } from "./types.js";

/** Due tasks locked per transaction. */
const BATCH = 100;
/** Batches per scan; what is left waits for the next minute. */
const MAX_BATCHES = 20;
/** A pending task run never fired this long after its tick: its fire job is enqueued again. */
const REPAIR_AFTER_MS = 10 * 60_000;
/** ... and this long after its tick it is given up (`skipped`, `missed`). */
const GIVE_UP_AFTER_MS = 60 * 60_000;
const REPAIR_BATCH = 100;

/**
 * The scheduled task scanner (spec §6), once a minute across replicas. In batches, each one
 * transaction, it locks due tasks (`FOR UPDATE SKIP LOCKED`, so replicas share the work and never
 * take the same task) and for each one: records the ticks missed outside the org's
 * `catchUpWindowMinutes` as one `skipped` run (`missed`), inserts the run of the latest tick in
 * the window (the unique `(task_id, scheduled_for)` key makes a second insert a no-op), moves
 * `next_run_at` to the next tick plus the task's jitter (or ends a `once` task, or one past its
 * `expires_at`), and after the commit enqueues `sched-fire-<taskRunId>`. Then it repairs lost fire
 * jobs: a run still `pending` and unfired long after its tick is enqueued again, and given up an
 * hour after it.
 */
@Injectable()
export class ScheduledTaskScanJob {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ScheduledTaskStore) private readonly store: ScheduledTaskStore,
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
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await this.scanBatch(now);
      total += n;
      if (n < BATCH) break;
    }
    await this.repair(now);
    return total;
  }

  @Transactional()
  private async scanBatch(now: Date): Promise<number> {
    const t = this.db;
    const due = await this.store.lockDue(t, now, BATCH);
    const settings = new Map<string, EffectiveScheduleSettings>();
    const fire: string[] = [];
    for (const task of due) {
      let s = settings.get(task.orgId);
      if (s === undefined) {
        s = await readScheduleSettings(t, this.config, task.orgId);
        settings.set(task.orgId, s);
      }
      const id = await this.advance(t, task, now, s.catchUpWindowMinutes);
      if (id !== null) fire.push(id);
    }
    if (fire.length > 0) afterCommit(() => this.enqueue(fire));
    return due.length;
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
    const ticks = dueTicks(
      task.trigger,
      new Date(dueTick.getTime() - 1),
      until,
      catchUpWindowMinutes,
    );
    const expires = task.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const missed = ticks.missed.filter((x) => x.getTime() <= expires);
    const fireAt = ticks.fire !== null && ticks.fire.getTime() <= expires ? ticks.fire : null;
    const first = missed[0];
    const last = missed.at(-1);
    if (first !== undefined && last !== undefined) {
      const skipped = await this.store.insertRun(t, {
        id: randomUUID(),
        taskId: task.id,
        orgId: task.orgId,
        scheduledFor: first,
        trial: false,
        status: "skipped",
        skipReason: "missed",
      });
      if (skipped && missed.length > 1) {
        await this.store.updateRun(t, skipped.id, {
          error: `${missed.length} scheduled times were missed, ${first.toISOString()} to ${last.toISOString()}`,
        });
      }
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
    const next = nextTick(task.trigger, until);
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
    if (lost.length > 0) {
      await this.db
        .updateTable("scheduled_task_runs")
        .set({ status: "skipped", skip_reason: "missed", error: "The run could not be started" })
        .where("id", "in", lost)
        .where("status", "=", "pending")
        .where("fired_at", "is", null)
        .execute();
    }
    await this.enqueue(retry);
  }
}
