import { hashKey, type QueryClient } from "@tanstack/react-query";
import { getOrgThemes, getPlatformTheme } from "../themes";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's themes and the viewer's resolved theme (the workspace layout's shell read). */
export const orgThemesQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).themes(),
    fn: () => getOrgThemes(orgId),
    freshness: "orgConfig",
  });

/** The platform default theme (the auth layout's read; a deployment-wide setting). */
export const platformThemeQuery = () =>
  defineQuery({
    key: keys.deployment().platformTheme(),
    fn: getPlatformTheme,
    freshness: "deployment",
  });

/** Whether `key` starts with `prefix` (TanStack's partial match). */
const startsWith = (key: readonly unknown[], prefix: readonly unknown[]): boolean =>
  prefix.every((p, i) => hashKey([key[i]]) === hashKey([p]));

/** Whether `k` is an org's themes read (`keys.org(id).themes()`, any org). */
const isOrgThemes = (k: readonly unknown[]): boolean =>
  k[0] === "org" && typeof k[1] === "string" && startsWith(k, keys.org(k[1]).themes());

/**
 * The themes read of every org in the cache. A person's theme pick holds in all their orgs (spec
 * §7), so it changes each org's resolved theme, not only the current one's: an org viewed later in
 * this tab refetches instead of painting the old theme from the cache.
 */
export function cachedOrgThemesKeys(qc: QueryClient): (readonly unknown[])[] {
  return qc
    .getQueryCache()
    .findAll({ predicate: ({ queryKey }) => isOrgThemes(queryKey) })
    .map((q) => q.queryKey);
}

/**
 * After a platform default change, in every cached org: its themes read (its resolved theme falls
 * back to the platform default) and its component lists (the default is locked on there); and the
 * platform default itself. Awaited.
 */
export function invalidatePlatformTheme(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.deployment().platformTheme() }),
    qc.invalidateQueries({
      predicate: ({ queryKey: k }) =>
        isOrgThemes(k) ||
        (k[0] === "org" &&
          typeof k[1] === "string" &&
          startsWith(k, keys.org(k[1]).componentsAll())),
    }),
  ]);
}
