/**
 * The maintenance job scheduler ids the storage purge had before becoming `@LockedCron` /
 * `@LockedInterval` jobs (retired at worker start, `RETIRED_SCHEDULER_IDS`). A leaf module.
 */

/** The maintenance job scheduler id it had before it became a cron (retired at worker start). */
export const STORAGE_PURGE_SCHEDULER_ID = "storage-org-purge-hourly";
