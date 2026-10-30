/**
 * The maintenance job scheduler ids the attachment cleanup had before becoming `@LockedCron` /
 * `@LockedInterval` jobs (retired at worker start, `RETIRED_SCHEDULER_IDS`). A leaf module.
 */

/** The retired BullMQ repeatable scheduler of the cleanup (removed from Redis at worker start). */
export const ATTACHMENT_CLEANUP_SCHEDULER_ID = "attachment-cleanup-hourly";
