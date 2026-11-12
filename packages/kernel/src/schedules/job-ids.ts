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
