import { getAdminClientExtensions, getOrgClientExtensions } from "../client-extensions";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's client extensions (the workspace layout's shell read; client extensions §11). */
export const clientExtensionsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).clientExtensions(),
    fn: () => getOrgClientExtensions(orgId),
    freshness: "orgConfig",
  });

/** One plugin's platform client set, read only by its `/admin/p/<plugin>/<id>` page (§9.6). */
export const adminClientExtensionsQuery = (plugin: string) =>
  defineQuery({
    key: keys.deployment().clientExtensions(plugin),
    fn: () => getAdminClientExtensions(plugin),
    freshness: "deployment",
  });
