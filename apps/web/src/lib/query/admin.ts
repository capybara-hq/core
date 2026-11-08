import {
  type DeploymentSettingsPatch,
  getAdminOverview,
  getDeploymentSettings,
  listAdminAccounts,
  listAdminOrgs,
} from "../admin";
import {
  getAdminExtension,
  getExtensionConfig,
  listAdminExtensions,
  listExtensionOrgOverrides,
} from "../admin-extensions";
import { getPlatformInbox, getPlatformInboxCount } from "../admin-inbox";
import {
  getCatalogItem,
  getStagedImport,
  listCatalogItems,
  listDeploymentRequests,
  listMarketplaceEntries,
  listMarketplaces,
  listPendingPlugins,
} from "../catalog";
import { getAdminModels, listAdminPurposes } from "../models";
import { defineQuery } from "./define";
import { keys } from "./keys";

// The admin console's reads (super admins): deployment data, so their keys start with
// `"deployment"` and they are fresh for `deployment` (web query cache spec §5).

const d = () => keys.deployment();

/** The overview's four numbers. */
export const adminOverviewQuery = () =>
  defineQuery({ key: d().adminOverview(), fn: () => getAdminOverview(), freshness: "deployment" });

/**
 * The super admin's inbox (`{ items, truncated }`): requests, permission confirmations, failed
 * scope syncs and a migration run that needs a look. Moves on its own (orgs ask, syncs fail).
 */
export const adminInboxQuery = () =>
  defineQuery({ key: d().adminInbox(), fn: () => getPlatformInbox(), freshness: "live" });

/** How many items wait in the super admin's inbox (`{ total }`; the admin sidebar polls it). */
export const adminInboxCountQuery = () =>
  defineQuery({
    key: d().adminInboxCount(),
    fn: () => getPlatformInboxCount(),
    freshness: "live",
  });

/** A page of accounts: the first (`after` omitted) or the one after a cursor ("Load more"). */
export const adminAccountsQuery = (after?: string) =>
  defineQuery({
    key: d().adminAccounts(after),
    fn: () => listAdminAccounts(after),
    freshness: "deployment",
  });

/** The deployment's orgs (`{ orgs }`). */
export const adminOrgsQuery = () =>
  defineQuery({ key: d().adminOrgs(), fn: () => listAdminOrgs(), freshness: "deployment" });

/** The deployment settings (`/admin/settings` and `/admin/orgs` share it). */
export const deploymentSettingsQuery = () =>
  defineQuery({
    key: d().settings(),
    fn: () => getDeploymentSettings(),
    freshness: "deployment",
  });

/**
 * What a deployment settings save changes besides the settings (written from the answer): the
 * models page (its price currency is the deployment's), `/me` when `orgCreation` changes (whether
 * the account may create an org), and the org settings of every org whose overrides it touches
 * (they carry the org's effective sandbox limits). `customConnectors` / `customSkills` reach no
 * cached read: the kernel applies them when a connector or skill is created.
 */
export const settingsChangeKeys = (patch: DeploymentSettingsPatch): (readonly unknown[])[] => {
  const orgIds = new Set([
    ...Object.keys(patch.runConcurrencyOverrides ?? {}),
    ...Object.keys(patch.sandboxLimitOverrides ?? {}),
    ...Object.keys(patch.subagentLimitOverrides ?? {}),
  ]);
  return [
    keys.deployment().adminModels(),
    ...(patch.orgCreation !== undefined ? [keys.account("self").me()] : []),
    // the platform default theme: the themes list marks it (every org's reads: `invalidatePlatformTheme`)
    ...(patch.uiTheme !== undefined ? [keys.deployment().components("theme")] : []),
    ...[...orgIds].map((id) => keys.org(id).orgSettings()),
  ];
};

/** The providers with their models and the price table. */
export const adminModelsQuery = () =>
  defineQuery({ key: d().adminModels(), fn: () => getAdminModels(), freshness: "deployment" });

/** The purposes' deployment defaults (`{ purposes }`). */
export const adminPurposesQuery = () =>
  defineQuery({
    key: d().adminPurposes(),
    fn: () => listAdminPurposes(),
    freshness: "deployment",
  });

/** The deployment's extensions (`{ extensions, drainSeconds }`). */
export const adminExtensionsQuery = () =>
  defineQuery({
    key: d().extensions(),
    fn: () => listAdminExtensions(),
    freshness: "deployment",
  });

/** One extension (the detail page polls it while it converges). */
export const adminExtensionQuery = (name: string) =>
  defineQuery({
    key: d().extension(name),
    fn: () => getAdminExtension(name),
    freshness: "deployment",
  });

/**
 * What an extension changing in an org (enabled, disabled, configured, installed or upgraded, on
 * the deployment or in the org) changes there besides the org's extensions list: its readiness (a
 * model provider enabled or configured), what the extensions bring (UI, pages, file previewers),
 * the models they provide and the purposes that map to them, the connector kinds, and the default
 * providers of the `org-default` points (their candidates and whether a point has a provider now)
 * and the extension tools an agent can select.
 */
export const orgExtensionChangeKeys = (orgId: string): (readonly unknown[])[] => {
  const k = keys.org(orgId);
  return [
    k.readiness(),
    k.contributions(),
    k.uiArrangement(),
    k.connectorKinds(),
    k.extensionPages(),
    k.orgFilePreviewers(),
    k.extensionPointDefaults(),
    k.extensionPointsAvailable(),
    k.extensionTools(),
    k.models(),
    k.modelsCatalog(),
    k.orgPurposes(),
  ];
};

/**
 * What a change to an extension on the deployment changes besides the extension itself: the
 * overview's count, the super admin's inbox and its count (its permission confirmations), and in
 * the current org (the only one cached) its extensions and {@link orgExtensionChangeKeys}.
 */
export const extensionChangeKeys = (orgId: string | null): (readonly unknown[])[] => [
  keys.deployment().adminOverview(),
  keys.deployment().adminInbox(),
  keys.deployment().adminInboxCount(),
  ...(orgId === null ? [] : [keys.org(orgId).orgExtensions(), ...orgExtensionChangeKeys(orgId)]),
];

/** One extension's deployment config (the detail page's Config tab). */
export const extensionConfigQuery = (name: string) =>
  defineQuery({
    key: d().extensionConfig(name),
    fn: () => getExtensionConfig(name),
    freshness: "deployment",
  });

/** The orgs holding a copy of one extension's overridable config (the Config tab's list). */
export const extensionOrgOverridesQuery = (name: string) =>
  defineQuery({
    key: d().extensionOrgOverrides(name),
    fn: () => listExtensionOrgOverrides(name).then((r) => r.overrides),
    freshness: "deployment",
  });

/** The catalog's items (`{ items, nextOffset }`). */
export const catalogItemsQuery = () =>
  defineQuery({ key: d().catalog(), fn: () => listCatalogItems(), freshness: "deployment" });

/** One catalog item with its versions (a 404 is the page's not-found). */
export const catalogItemQuery = (itemId: string) =>
  defineQuery({
    key: d().catalogItem(itemId),
    fn: () => getCatalogItem(itemId),
    freshness: "deployment",
  });

/** A staged import's review (`plugin.staging_not_found` once expired or confirmed). */
export const stagedImportQuery = (stagingId: string) =>
  defineQuery({
    key: d().stagedImport(stagingId),
    fn: () => getStagedImport(stagingId),
    freshness: "deployment",
  });

/** The plugins waiting for a permission confirmation (`{ items }`). */
export const pendingPluginsQuery = () =>
  defineQuery({
    key: d().catalogPending(),
    fn: () => listPendingPlugins(),
    freshness: "deployment",
  });

/** The pending catalog requests at the deployment stage (`{ requests }`). */
export const deploymentRequestsQuery = () =>
  defineQuery({
    key: d().catalogRequests(),
    fn: () => listDeploymentRequests(),
    freshness: "deployment",
  });

/** The marketplaces (`{ items, offline }`). */
export const marketplacesQuery = () =>
  defineQuery({ key: d().marketplaces(), fn: () => listMarketplaces(), freshness: "deployment" });

/** The marketplace entries of one source and search (empty: all sources, no search). */
export const marketplaceEntriesQuery = (sourceId: string, q: string) =>
  defineQuery({
    key: d().marketplaceEntries(sourceId, q),
    fn: () =>
      listMarketplaceEntries({
        ...(sourceId !== "" && { sourceId }),
        ...(q !== "" && { q }),
      }),
    freshness: "deployment",
  });
