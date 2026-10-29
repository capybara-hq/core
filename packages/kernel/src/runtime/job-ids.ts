/**
 * The maintenance job scheduler ids the runtime's fixed-period jobs had before they became
 * `@LockedCron` jobs (nest kernel Task 3.6b): an upgraded deployment still has them in Redis, so the
 * worker removes them at start (`RETIRED_SCHEDULER_IDS`). A leaf module: the maintenance worker
 * imports it without the runtime's providers.
 */

/** The wait sweep's old scheduler (every 10 minutes). */
export const WAIT_SWEEP_SCHEDULER_ID = "wait-sweep-every-10m";

/** The usage sweeper's old scheduler (every minute). */
export const USAGE_SWEEP_SCHEDULER_ID = "usage-report-sweep-every";
