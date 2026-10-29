import type { Queue } from "bullmq";
import {
  MARKETPLACES_REFRESH_SCHEDULER_ID,
  PLUGIN_STAGING_CLEANUP_SCHEDULER_ID,
} from "../../catalog/job-ids.js";
import { GATEWAY_CHECK_SCHEDULER_ID } from "../../channels/job-ids.js";
import { ATTACHMENT_CLEANUP_SCHEDULER_ID } from "../../conversations/attachments.service.js";
import { PLUGINS_RECONCILE_SCHEDULER_ID } from "../../extensions/lifecycle-topics.js";
import { DIRECTORY_SCAN_SCHEDULER_ID } from "../../orgs/directory-sync.js";
import { OFFBOARD_SWEEP_SCHEDULER_ID } from "../../orgs/offboarding.js";
import { USAGE_SWEEP_SCHEDULER_ID, WAIT_SWEEP_SCHEDULER_ID } from "../../runtime/job-ids.js";
import {
  SANDBOX_DESTROY_SCHEDULER_ID,
  SANDBOX_SUSPEND_SCHEDULER_ID,
} from "../../sandbox/job-ids.js";
import { STORAGE_PURGE_SCHEDULER_ID } from "../../storage/purge.js";
import { DRIFT_SCHEDULER_ID, OUTPUT_CLEANUP_SCHEDULER_ID } from "../../tools/job-ids.js";

/**
 * Job scheduler ids of the maintenance queue's fixed-period jobs before they became `@LockedCron` /
 * `@LockedInterval` jobs (nest kernel Phase 3): an upgraded deployment still has them in Redis, so
 * a starting worker role removes them (else BullMQ keeps firing a job no handler knows). Each id
 * comes from its job's exported constant.
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

/** Removes the {@link RETIRED_SCHEDULER_IDS} from `queue` (idempotent; replicas may race). */
export async function removeRetiredSchedulers(
  queue: Pick<Queue, "removeJobScheduler">,
): Promise<void> {
  for (const id of RETIRED_SCHEDULER_IDS) await queue.removeJobScheduler(id);
}
