import { getOrgCatalogItem, listOrgCatalog, listOrgMarketplaceEntries } from "../catalog";
import { orgExtensionChangeKeys } from "./admin";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The catalog from the org's view (`{ items }`, as the kernel answers). */
export const orgCatalogQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).catalog(),
    fn: () => listOrgCatalog(orgId),
    freshness: "orgConfig",
  });

/** One catalog item from the org's view (a 404 is the page's not-found). */
export const orgCatalogItemQuery = (orgId: string, itemId: string) =>
  defineQuery({
    key: keys.org(orgId).catalogItem(itemId),
    fn: () => getOrgCatalogItem(orgId, itemId),
    freshness: "orgConfig",
  });

/**
 * What installing (or upgrading) a plugin in the org changes: the catalog's view of it (and of the
 * dependencies installed with it), the installed plugins, and the components a plugin brings
 * (connectors, skills, agent templates, extensions and what they change: readiness, UI, models and
 * purposes, see {@link orgExtensionChangeKeys}).
 */
export const pluginChangeKeys = (orgId: string): (readonly unknown[])[] => [
  keys.org(orgId).catalogItemsAll(),
  ...pluginChangeKeysButDetail(orgId),
];

/**
 * {@link pluginChangeKeys} without the catalog item reads: what a delete invalidates while its
 * detail page is still showing (reading the deleted item again would flash the not-found state).
 */
export const pluginChangeKeysButDetail = (orgId: string): (readonly unknown[])[] => {
  const k = keys.org(orgId);
  return [
    k.catalog(),
    k.pluginInstalls(),
    k.connectors(),
    k.orgExtensions(),
    ...orgExtensionChangeKeys(orgId),
    k.skills(),
    k.agentTemplates(),
    k.componentsAll(),
  ];
};

/**
 * The marketplace entries an org admin browses to request an import (empty source: all sources,
 * empty search: none); a 404 means the deployment turned `orgMarketplaceBrowse` off.
 */
export const orgMarketplaceEntriesQuery = (orgId: string, sourceId: string, q: string) =>
  defineQuery({
    key: keys.org(orgId).marketplaceEntries(sourceId, q),
    fn: () =>
      listOrgMarketplaceEntries(orgId, {
        ...(sourceId !== "" && { sourceId }),
        ...(q !== "" && { q }),
      }),
    freshness: "orgConfig",
  });

/**
 * What a plugin's scope, disable, switch, update or permission confirmation changes: the catalog,
 * the platform components (their effective scope and versions) and the extensions on the
 * deployment (and the 待确认 list, the overview, the super admin's inbox and its count), and in
 * the current org the catalog, the installed plugins and what {@link pluginChangeKeys} lists.
 */
export const pluginScopeChangeKeys = (orgId: string | null): (readonly unknown[])[] => {
  const d = keys.deployment();
  return [
    d.catalog(),
    d.catalogItemsAll(),
    d.catalogPending(),
    d.componentsAll(),
    d.extensions(),
    d.adminOverview(),
    d.adminInbox(),
    d.adminInboxCount(),
    ...(orgId === null ? [] : pluginChangeKeys(orgId)),
  ];
};
