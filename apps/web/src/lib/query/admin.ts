import {
  getAdminOverview,
  getDeploymentSettings,
  listAdminAccounts,
  listAdminOrgs,
} from "../admin";
import { getExtensionConfig, listAdminExtensions } from "../admin-extensions";
import {
  getCatalogItem,
  getStagedImport,
  listCatalogItems,
  listDeploymentRequests,
  listMarketplaceEntries,
  listMarketplaces,
} from "../catalog";
import { getAdminModels, listAdminPurposes } from "../models";
import { defineQuery } from "./define";
import { keys } from "./keys";

// The admin console's reads (enterprise admins): deployment data, so their keys start with
// `"deployment"` and they are fresh for `deployment` (web query cache spec §5).

const d = () => keys.deployment();

/** The overview's four numbers. */
export const adminOverviewQuery = () =>
  defineQuery({ key: d().adminOverview(), fn: () => getAdminOverview(), freshness: "deployment" });

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

/** One extension's deployment config (the detail page's Config tab). */
export const extensionConfigQuery = (name: string) =>
  defineQuery({
    key: d().extensionConfig(name),
    fn: () => getExtensionConfig(name),
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
