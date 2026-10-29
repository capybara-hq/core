/**
 * The channel gateway check's job name and the maintenance job scheduler id it had before it
 * became a `@LockedCron` job (nest kernel Task 3.7): an upgraded deployment still has the
 * scheduler in Redis, so the worker removes it at start (`RETIRED_SCHEDULER_IDS`). A leaf module:
 * the maintenance worker imports it without the channel providers.
 */

/** The gateway check's job name (`@LockedCron`). */
export const GATEWAY_CHECK_JOB = "channel-gateway-check";

/** The gateway check's old scheduler (every minute). */
export const GATEWAY_CHECK_SCHEDULER_ID = "channel-gateway-check-every";
