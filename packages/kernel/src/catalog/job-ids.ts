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
