import type { OutboxService } from "../infra/outbox/outbox.service.js";

/** The scheduled tasks' jobs (a leaf module: type imports only). */

/**
 * The once-a-minute `@LockedCron` that turns due tasks into task runs (spec §6); its name enqueued
 * on the maintenance queue runs one scan (`ScheduledRuns.runNow`).
 */
export const SCHED_SCAN_JOB = "scheduled-task-scan";

/** The one-off job that checks and starts one task run, on `cap-kernel-maintenance`. */
export const SCHED_FIRE_JOB = "sched-fire";

/** The data of a {@link SCHED_FIRE_JOB}. */
export interface SchedFireJobData {
  taskRunId: string;
}

/** The fire job's id: `sched-fire-<taskRunId>` (no `:`, task run ids are UUIDs). */
export const schedFireJobId = (taskRunId: string): string => `${SCHED_FIRE_JOB}-${taskRunId}`;

/**
 * Owes the fire job of task run `taskRunId` in the transaction in context (transactional outbox
 * spec §8.1): the transaction that writes a pending task run (the scan's tick, a person's "run
 * now") owes its fire, so a tick is never left unfired. The job's options are its outbox registry
 * entry's; the fire is idempotent on the task run's status.
 */
export function oweSchedFire(
  outbox: Pick<OutboxService, "add">,
  taskRunId: string,
  orgId: string,
): Promise<boolean> {
  return outbox.add<SchedFireJobData>({
    queue: "cap-kernel-maintenance",
    name: SCHED_FIRE_JOB,
    jobId: schedFireJobId(taskRunId),
    data: { taskRunId },
    orgId,
  });
}

/**
 * The delayed job that settles a task run claimed but never started (ruling R26), on
 * `cap-kernel-maintenance`: owed by the fire job's claim, checks the run with the run tracker.
 */
export const SCHED_SETTLE_JOB = "sched-settle";

/** The data of a {@link SCHED_SETTLE_JOB}: `check` counts the checks before this one. */
export interface SchedSettleJobData {
  taskRunId: string;
  check: number;
}

/**
 * The first check: 10 minutes after the claim, when the start's retries (seconds) are long over
 * and the run tracker's start grace (`START_GRACE_MS`, 5 minutes) has passed, so a run that left
 * no trace is released at once.
 */
export const SCHED_SETTLE_AFTER_MS = 10 * 60_000;
/** A run still in flight at a check (its item queued, its message posted) is checked again hourly. */
export const SCHED_SETTLE_RECHECK_MS = 60 * 60_000;

/** The settle job's id: `sched-settle-<taskRunId>`, then `-<check>` for the later checks. */
export const schedSettleJobId = (taskRunId: string, check: number): string =>
  check === 0 ? `${SCHED_SETTLE_JOB}-${taskRunId}` : `${SCHED_SETTLE_JOB}-${taskRunId}-${check}`;

/**
 * Owes check number `check` of task run `taskRunId` in the transaction in context, due `after`
 * milliseconds from now.
 */
export function oweSchedSettle(
  outbox: Pick<OutboxService, "add">,
  taskRunId: string,
  orgId: string,
  check: number,
  after: number,
): Promise<boolean> {
  return outbox.add<SchedSettleJobData>({
    queue: "cap-kernel-maintenance",
    name: SCHED_SETTLE_JOB,
    jobId: schedSettleJobId(taskRunId, check),
    data: { taskRunId, check },
    runAt: new Date(Date.now() + after),
    orgId,
  });
}
