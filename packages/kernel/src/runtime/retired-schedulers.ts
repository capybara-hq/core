import {
  MARKETPLACES_REFRESH_SCHEDULER_ID,
  PLUGIN_STAGING_CLEANUP_SCHEDULER_ID,
} from "../catalog/job-ids.js";
import { GATEWAY_CHECK_SCHEDULER_ID } from "../channels/job-ids.js";
import { ATTACHMENT_CLEANUP_SCHEDULER_ID } from "../conversations/job-ids.js";
import { PLUGINS_RECONCILE_SCHEDULER_ID } from "../extensions/job-ids.js";
import { DIRECTORY_SCAN_SCHEDULER_ID, OFFBOARD_SWEEP_SCHEDULER_ID } from "../orgs/job-ids.js";
import { SANDBOX_DESTROY_SCHEDULER_ID, SANDBOX_SUSPEND_SCHEDULER_ID } from "../sandbox/job-ids.js";
import { STORAGE_PURGE_SCHEDULER_ID } from "../storage/job-ids.js";
import { DRIFT_SCHEDULER_ID, OUTPUT_CLEANUP_SCHEDULER_ID } from "../tools/job-ids.js";
import { USAGE_SWEEP_SCHEDULER_ID, WAIT_SWEEP_SCHEDULER_ID } from "./job-ids.js";

/**
 * Job scheduler ids of the maintenance queue's fixed-period jobs before they became `@LockedCron` /
 * `@LockedInterval` jobs (nest kernel Phase 3): an upgraded deployment still has them in Redis, so
 * a starting worker role removes them (else BullMQ keeps firing a job no handler knows). Each id
 * comes from its domain's leaf `job-ids.ts`, so this module imports no domain code.
 */
export const RETIRED_SCHEDULER_IDS: readonly string[] = [
  // Task 3.1
  STORAGE_PURGE_SCHEDULER_ID,
  // Task 3.2
  DIRECTORY_SCAN_SCHEDULER_ID,
  OFFBOARD_SWEEP_SCHEDULER_ID,
  // Task 3.3
  PLUGINS_RECONCILE_SCHEDULER_ID,
  // Task 3.4
  MARKETPLACES_REFRESH_SCHEDULER_ID,
  PLUGIN_STAGING_CLEANUP_SCHEDULER_ID,
  // Task 3.5
  DRIFT_SCHEDULER_ID,
  OUTPUT_CLEANUP_SCHEDULER_ID,
  // Task 3.6a
  ATTACHMENT_CLEANUP_SCHEDULER_ID,
  // Task 3.6b
  WAIT_SWEEP_SCHEDULER_ID,
  USAGE_SWEEP_SCHEDULER_ID,
  // Task 3.7
  GATEWAY_CHECK_SCHEDULER_ID,
  // Task 3.8
  SANDBOX_SUSPEND_SCHEDULER_ID,
  SANDBOX_DESTROY_SCHEDULER_ID,
];
