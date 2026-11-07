/** The catalog's periodic jobs (a leaf module: no imports). */

/**
 * Periodic marketplace refresh (C26), every `marketplaces.refreshIntervalMinutes` (a
 * `@LockedInterval`, once per tick across replicas): refreshes each enabled marketplace in turn.
 */
export const MARKETPLACES_REFRESH_JOB = "catalogs-refresh";
/** The BullMQ repeatable scheduler the refresh had before it became `@LockedInterval` (retired). */
export const MARKETPLACES_REFRESH_SCHEDULER_ID = "catalogs-refresh-every";

/**
 * Hourly cleanup of plugin import staging (T25, F-AE; a `@LockedCron`): deletes expired (24-hour)
 * staging rows and their object storage prefixes (`PluginImport.cleanupExpired`).
 */
export const PLUGIN_STAGING_CLEANUP_JOB = "app-staging-cleanup";
/** The BullMQ repeatable scheduler the cleanup had before it became `@LockedCron` (retired). */
export const PLUGIN_STAGING_CLEANUP_SCHEDULER_ID = "app-staging-cleanup-hourly";

/**
 * The one-off job that takes out the extension of a removed org-owned plugin (spec §14, P3-20,
 * P3-21; `OwnedPluginCleanup.run`), on `cap-kernel-maintenance`.
 */
export const OWNED_PLUGIN_CLEANUP_JOB = "owned-plugin-cleanup";

/** The daily `@LockedCron` repairing lost {@link OWNED_PLUGIN_CLEANUP_JOB} enqueues. */
export const OWNED_PLUGIN_CLEANUP_SWEEP_JOB = "owned-plugin-cleanup-sweep";

/** The data of an {@link OWNED_PLUGIN_CLEANUP_JOB}. */
export interface OwnedPluginCleanupData {
  itemId: string;
}

/**
 * The cleanup job of one removed item: id `owned-plugin-cleanup-<itemId>` (no `:`: item ids are
 * UUIDs), removed when done so a later enqueue of the same item is not swallowed; the job is
 * idempotent, so a few retries are safe.
 */
export function ownedPluginCleanupJob(itemId: string): {
  name: string;
  data: OwnedPluginCleanupData;
  opts: {
    jobId: string;
    attempts: number;
    backoff: { type: "exponential"; delay: number };
    removeOnComplete: true;
    removeOnFail: true;
  };
} {
  return {
    name: OWNED_PLUGIN_CLEANUP_JOB,
    data: { itemId },
    opts: {
      jobId: `${OWNED_PLUGIN_CLEANUP_JOB}-${itemId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  };
}
