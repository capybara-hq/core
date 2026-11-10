import { hashKey, type QueryClient } from "@tanstack/react-query";
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

/** Whether `key` starts with `prefix` (TanStack's partial match). */
const startsWith = (key: readonly unknown[], prefix: readonly unknown[]): boolean =>
  prefix.every((p, i) => hashKey([key[i]]) === hashKey([p]));

/**
 * A deployment-wide change to what client code runs (the kill switch, its per-plugin list, the
 * platform arrangement's replacements): marks the client set of every cached org and every
 * platform set stale (active ones refetch), so open pages drop or pick up the code at once.
 * Awaited.
 */
export function invalidateClientSets(qc: QueryClient): Promise<unknown> {
  return qc.invalidateQueries({
    predicate: ({ queryKey: k }) =>
      startsWith(k, keys.deployment().clientExtensionsAll()) ||
      (k[0] === "org" &&
        typeof k[1] === "string" &&
        startsWith(k, keys.org(k[1]).clientExtensions())),
  });
}
