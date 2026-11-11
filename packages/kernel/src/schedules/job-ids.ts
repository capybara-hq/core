/** The scheduled tasks' jobs (a leaf module: no imports). */

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
 * The fire job of one task run. Removed when done, so the scanner's repair can enqueue it again
 * after a lost job; the fire is idempotent on the task run's status, so retries are safe.
 */
export function schedFireJob(taskRunId: string): {
  name: string;
  data: SchedFireJobData;
  opts: {
    jobId: string;
    attempts: number;
    backoff: { type: "exponential"; delay: number };
    removeOnComplete: true;
    removeOnFail: true;
  };
} {
  return {
    name: SCHED_FIRE_JOB,
    data: { taskRunId },
    opts: {
      jobId: schedFireJobId(taskRunId),
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  };
}
