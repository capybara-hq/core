/**
 * The maintenance job scheduler ids the sandbox sweeps had before they became `@LockedCron` jobs
 * (nest kernel Task 3.8): an upgraded deployment still has them in Redis, so the worker removes
 * them at start (`RETIRED_SCHEDULER_IDS`). A leaf module: the maintenance worker imports it without
 * the sandbox providers.
 */

/** The idle suspension sweep's old scheduler (every minute). */
export const SANDBOX_SUSPEND_SCHEDULER_ID = "sandbox-suspend-idle-every-minute";

/** The inactivity destruction sweep's old scheduler (hourly). */
export const SANDBOX_DESTROY_SCHEDULER_ID = "sandbox-destroy-inactive-hourly";
