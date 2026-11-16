// The tools' job names: a leaf module (no service imports), read by the maintenance queue.

/** The periodic drift scan (`@LockedInterval`, tools/jobs.ts). */
export const DRIFT_SCAN_JOB = "drift-scan";
/**
 * 单个连接器的漂移检查任务名（维护队列上的一次性任务：生产方是 `ToolDrift`，消费方是
 * `MaintenanceProcessor`）。
 */
export const DRIFT_CONNECTOR_JOB = "drift-connector";

/** The hourly cleanup of expired tool output archives (`@LockedCron`, tools/jobs.ts). */
export const OUTPUT_CLEANUP_JOB = "output-cleanup";
