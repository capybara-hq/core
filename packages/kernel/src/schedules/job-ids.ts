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
 * The delayed job that settles a task run left pending (ruling R26, fix round 1), on
 * `cap-kernel-maintenance`. Two kinds:
 * - the claimed check, owed by the fire job's claim: the run tracker links, settles or releases a
 *   run claimed but never started (`sched-settle-<taskRunId>`, then `-<check>`);
 * - the unfired check, owed with the task run itself (the scan's tick, "run now"): a run its fire
 *   job never claimed (the job failed for good before its claim) is skipped, `missed` for a tick,
 *   `removed` for a "run now", so it never blocks the task's later ticks as an overlap
 *   (`sched-settle-<taskRunId>-unfired`).
 */
export const SCHED_SETTLE_JOB = "sched-settle";

/**
 * The data of a {@link SCHED_SETTLE_JOB}: the claimed check (`check` counts the checks before this
 * one) or the unfired check.
 */
export type SchedSettleJobData =
  | { taskRunId: string; check: number }
  | { taskRunId: string; unfired: true };

/**
 * The first claimed check: 10 minutes after the claim, when the start's retries (seconds) are long
 * over and the run tracker's start grace (`START_GRACE_MS`, 5 minutes) has passed, so a run that
 * left no trace is released at once. Also the unfired check's delay after a "run now".
 */
export const SCHED_SETTLE_AFTER_MS = 10 * 60_000;
/**
 * A claimed run still in flight at a check (its item queued, its message posted and not yet taken
 * by a run) is checked again hourly. The chain ends with the first check that finds the run
 * started, ended or released: the queued item is consumed or removed, the message taken by a run.
 * A chain past {@link SCHED_SETTLE_LONG_CHECKS} checks (a week) is logged as a warning, once.
 */
export const SCHED_SETTLE_RECHECK_MS = 60 * 60_000;
/** A week of hourly checks: the claimed check warns at this one (a run in flight that long). */
export const SCHED_SETTLE_LONG_CHECKS = 168;
/**
 * How long past the org's catch-up window a tick's fire may come before the tick is missed (the
 * fire job's own rule, and when a tick's unfired check runs): the scan fires a tick still inside
 * the window, and its fire job follows within seconds.
 */
export const SCHED_LATE_FIRE_SLACK_MS = 10 * 60_000;

/** The claimed check's id: `sched-settle-<taskRunId>`, then `-<check>` for the later checks. */
export const schedSettleJobId = (taskRunId: string, check: number): string =>
  check === 0 ? `${SCHED_SETTLE_JOB}-${taskRunId}` : `${SCHED_SETTLE_JOB}-${taskRunId}-${check}`;

/** The unfired check's id: `sched-settle-<taskRunId>-unfired`. */
export const schedSettleUnfiredJobId = (taskRunId: string): string =>
  `${SCHED_SETTLE_JOB}-${taskRunId}-unfired`;

/**
 * Owes claimed check number `check` of task run `taskRunId` in the transaction in context, due
 * `after` milliseconds from now.
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

/**
 * Owes the unfired check of task run `taskRunId` in the transaction that writes the run: for a
 * tick of the schedule (`catchUpWindowMinutes` given) when the fire job would itself call the
 * tick missed (its tick plus the window plus {@link SCHED_LATE_FIRE_SLACK_MS}, at least
 * {@link SCHED_SETTLE_AFTER_MS} on); for a "run now" (null) {@link SCHED_SETTLE_AFTER_MS} on.
 */
export function oweSchedSettleUnfired(
  outbox: Pick<OutboxService, "add">,
  taskRunId: string,
  orgId: string,
  scheduledFor: Date,
  catchUpWindowMinutes: number | null,
): Promise<boolean> {
  const soonest = Date.now() + SCHED_SETTLE_AFTER_MS;
  const at =
    catchUpWindowMinutes === null
      ? soonest
      : Math.max(
          soonest,
          scheduledFor.getTime() + catchUpWindowMinutes * 60_000 + SCHED_LATE_FIRE_SLACK_MS,
        );
  return outbox.add<SchedSettleJobData>({
    queue: "cap-kernel-maintenance",
    name: SCHED_SETTLE_JOB,
    jobId: schedSettleUnfiredJobId(taskRunId),
    data: { taskRunId, unfired: true },
    runAt: new Date(at),
    orgId,
  });
}
