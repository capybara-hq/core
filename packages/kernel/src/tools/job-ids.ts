// The tools' job names and the retired scheduler ids: a leaf module (no service imports), read by
// the maintenance queue's retirement list.

/** The periodic drift scan (`@LockedInterval`, tools/jobs.ts). */
export const DRIFT_SCAN_JOB = "drift-scan";
/** The BullMQ repeatable scheduler the scan had before it became `@LockedInterval` (retired). */
export const DRIFT_SCHEDULER_ID = "drift-scan-interval";
/**
 * 单个连接器的漂移检查任务名（维护队列上的一次性任务：生产方是 `ToolDrift`，消费方是
 * `MaintenanceProcessor`）。
 */
export const DRIFT_CONNECTOR_JOB = "drift-connector";

/** The hourly cleanup of expired tool output archives (`@LockedCron`, tools/jobs.ts). */
export const OUTPUT_CLEANUP_JOB = "output-cleanup";
/** The BullMQ repeatable scheduler the cleanup had before it became `@LockedCron` (retired). */
export const OUTPUT_CLEANUP_SCHEDULER_ID = "output-cleanup-hourly";
