import { getOrgCatalogItem, listOrgCatalog, previewPluginUpgrade } from "../catalog";
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
 * dependencies installed with it), the installed plugins, and the components a plugin brings (connectors, extensions and their UI,
 * skills, agent templates).
 */
export const pluginChangeKeys = (orgId: string): (readonly unknown[])[] => {
  const k = keys.org(orgId);
  return [
    k.catalog(),
    k.catalogItemsAll(),
    k.pluginInstalls(),
    k.connectors(),
    k.orgExtensions(),
    k.contributions(),
    k.extensionPages(),
    k.skills(),
    k.agentTemplates(),
  ];
};

/** What upgrading an installed plugin to `version` changes and needs (the upgrade dialog's read). */
export const pluginUpgradePreviewQuery = (orgId: string, installId: string, version: string) =>
  defineQuery({
    key: keys.org(orgId).pluginUpgradePreview(installId, version),
    fn: () => previewPluginUpgrade(orgId, installId, version),
    freshness: "live",
  });
