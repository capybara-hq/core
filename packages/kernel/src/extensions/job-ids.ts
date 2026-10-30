/**
 * The maintenance job scheduler ids the plugins reconcile had before becoming `@LockedCron` /
 * `@LockedInterval` jobs (retired at worker start, `RETIRED_SCHEDULER_IDS`). A leaf module.
 */

/** The BullMQ repeatable scheduler the job had before it became `@LockedInterval` (retired). */
export const PLUGINS_RECONCILE_SCHEDULER_ID = "plugins-reconcile-every";
