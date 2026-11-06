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
export const pluginChangeKeys = (orgId: string): (readonly unknown[])[] => {
  const k = keys.org(orgId);
  return [
    k.catalog(),
    k.catalogItemsAll(),
    k.pluginInstalls(),
    k.connectors(),
    k.orgExtensions(),
    ...orgExtensionChangeKeys(orgId),
    k.skills(),
    k.agentTemplates(),
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
 * deployment (and the 待确认 list, the overview), and in the current org the catalog, the
 * installed plugins and what {@link pluginChangeKeys} lists.
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
    ...(orgId === null ? [] : pluginChangeKeys(orgId)),
  ];
};
