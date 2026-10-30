/**
 * The maintenance job scheduler ids the offboarding sweep and the directory scan had before
 * becoming `@LockedCron` jobs (retired at worker start, `RETIRED_SCHEDULER_IDS`). A leaf module.
 */

/** The offboarding sweep's old scheduler (every 10 minutes). */
export const OFFBOARD_SWEEP_SCHEDULER_ID = "offboard-sweep-every-10m";
/** The directory scan's old scheduler (hourly). */
export const DIRECTORY_SCAN_SCHEDULER_ID = "directory-scan-hourly";
