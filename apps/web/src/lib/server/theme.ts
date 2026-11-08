import "server-only";
import type { Metadata } from "next";
import { meQuery } from "../query/shell";
import { orgThemesQuery, platformThemeQuery } from "../query/themes";
import type { ThemeRef } from "../themes";
import { serverQueryClient } from "./query";

/** The page icon of a theme with a favicon (themes spec §4.3); nothing otherwise (the app's icon). */
export function themeIcons(theme: ThemeRef | null): Metadata {
  const favicon = theme?.logo?.faviconUrl ?? null;
  return favicon === null ? {} : { icons: { icon: favicon } };
}

/**
 * The workspace layout's metadata: the viewer's theme icon. The reads go through the request's
 * query client, so they are the ones the layout's shell read makes (one kernel call each); any
 * failure leaves the metadata alone (the layout decides what a failure means).
 */
export async function workspaceThemeMetadata(): Promise<Metadata> {
  const qc = serverQueryClient();
  try {
    const me = await qc.fetchQuery({ ...meQuery(), retry: false });
    const orgId = me.memberships.some((m) => m.orgId === me.currentOrgId) ? me.currentOrgId : null;
    const theme =
      orgId === null
        ? await qc.fetchQuery({ ...platformThemeQuery(), retry: false })
        : (await qc.fetchQuery({ ...orgThemesQuery(orgId), retry: false })).resolved;
    return themeIcons(theme);
  } catch {
    return {};
  }
}

/** The public pages' metadata: the platform default theme's icon. */
export async function platformThemeMetadata(): Promise<Metadata> {
  try {
    return themeIcons(
      await serverQueryClient().fetchQuery({ ...platformThemeQuery(), retry: false }),
    );
  } catch {
    return {};
  }
}
