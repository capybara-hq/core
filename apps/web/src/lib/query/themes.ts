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

/**
 * After a platform default change, in every cached org: its themes read (its resolved theme falls
 * back to the platform default) and its component lists (the default is locked on there); and the
 * platform default itself. Awaited.
 */
export function invalidatePlatformTheme(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: keys.deployment().platformTheme() }),
    qc.invalidateQueries({
      predicate: ({ queryKey: k }) => {
        if (k[0] !== "org" || typeof k[1] !== "string") return false;
        const org = keys.org(k[1]);
        return startsWith(k, org.themes()) || startsWith(k, org.componentsAll());
      },
    }),
  ]);
}
