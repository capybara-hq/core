import type { OutboxService } from "../infra/outbox/outbox.service.js";

/** The catalog's job names and ids (a leaf module: type imports only). */

/**
 * Periodic marketplace refresh (C26), every `marketplaces.refreshIntervalMinutes` (a
 * `@LockedInterval`, once per tick across replicas): refreshes each enabled marketplace in turn.
 */
export const MARKETPLACES_REFRESH_JOB = "catalogs-refresh";

/**
 * Hourly cleanup of plugin import staging (T25, F-AE; a `@LockedCron`): deletes expired (24-hour)
 * staging rows and their object storage prefixes (`PluginImport.cleanupExpired`).
 */
export const PLUGIN_STAGING_CLEANUP_JOB = "app-staging-cleanup";

/**
 * The backstop sweep of template connectors (ruling R30; a `@LockedInterval`, once per tick across
 * replicas, every {@link TEMPLATE_CONNECTORS_SWEEP_PERIOD_MS}): orgs with a template connector they
 * never had whose connector kind is available now get the ensure (`TemplateConnectorEnsurer.sweep`).
 */
export const TEMPLATE_CONNECTORS_SWEEP_JOB = "template-connectors-sweep";

/**
 * Five minutes: the queued ensure retries for about ten minutes after an install or a switch-on,
 * so the sweep only catches what outlives that (a kind loaded later, an always-on extension); a
 * connector that waited that long can wait one more period, and the candidates query runs only
 * twelve times an hour.
 */
export const TEMPLATE_CONNECTORS_SWEEP_PERIOD_MS = 5 * 60_000;

/** Orgs one sweep tick ensures at most (the rest follow on the next ticks). */
export const TEMPLATE_CONNECTORS_SWEEP_BATCH = 50;

/**
 * The one-off job that takes out the extension of a removed org-owned plugin (spec §14, P3-20,
 * P3-21; `OwnedPluginCleanup.run`), on `cap-kernel-maintenance`.
 */
export const OWNED_PLUGIN_CLEANUP_JOB = "owned-plugin-cleanup";

/** The data of an {@link OWNED_PLUGIN_CLEANUP_JOB}. */
export interface OwnedPluginCleanupData {
  itemId: string;
}

/** The cleanup job id of one removed item (no `:`: item ids are UUIDs). */
export const ownedPluginCleanupJobId = (itemId: string): string =>
  `${OWNED_PLUGIN_CLEANUP_JOB}-${itemId}`;

/**
 * Owes the cleanup of removed item `itemId` in the transaction in context (transactional outbox
 * spec §8.1): the removal and its cleanup commit together. Platform work (no org: the owner org
 * may be the one being deleted). The job's options are its outbox registry entry's.
 */
export function oweOwnedPluginCleanup(
  outbox: Pick<OutboxService, "add">,
  itemId: string,
): Promise<boolean> {
  return outbox.add<OwnedPluginCleanupData>({
    queue: "cap-kernel-maintenance",
    name: OWNED_PLUGIN_CLEANUP_JOB,
    jobId: ownedPluginCleanupJobId(itemId),
    data: { itemId },
  });
}
