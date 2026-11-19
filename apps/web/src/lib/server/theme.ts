import "server-only";
import type { Metadata, ResolvedMetadata, ResolvingMetadata } from "next";
import { meQuery } from "../query/shell";
import { orgThemesQuery, platformThemeQuery } from "../query/themes";
import type { ThemeRef } from "../themes";
import { serverQueryClient } from "./query";

/**
 * The page icon of a theme with a favicon (themes spec §4.3); nothing otherwise (the root layout's
 * platform icons). Next replaces `icons` whole, so the parent's other icons (the apple-touch-icon)
 * are kept beside the theme's favicon.
 */
export function themeIcons(theme: ThemeRef | null, parent: ResolvedIcons = null): Metadata {
  const favicon = theme?.logo?.faviconUrl ?? null;
  if (favicon === null) return {};
  return { icons: { ...(parent ?? {}), icon: favicon } as NonNullable<Metadata["icons"]> };
}

/** The icons the layouts above resolved. */
type ResolvedIcons = ResolvedMetadata["icons"];

/** The parent layouts' icons, or none when they cannot be read. */
async function parentIcons(parent: ResolvingMetadata | undefined): Promise<ResolvedIcons> {
  try {
    return parent === undefined ? null : (await parent).icons;
  } catch {
    return null;
  }
}

/**
 * The workspace layout's metadata: the viewer's theme icon. The reads go through the request's
 * query client, so they are the ones the layout's shell read makes (one kernel call each); any
 * failure leaves the metadata alone (the layout decides what a failure means).
 */
export async function workspaceThemeMetadata(
  _props?: unknown,
  parent?: ResolvingMetadata,
): Promise<Metadata> {
  const qc = serverQueryClient();
  try {
    const me = await qc.fetchQuery({ ...meQuery(), retry: false });
    const orgId = me.memberships.some((m) => m.orgId === me.currentOrgId) ? me.currentOrgId : null;
    const theme =
      orgId === null
        ? await qc.fetchQuery({ ...platformThemeQuery(), retry: false })
        : (await qc.fetchQuery({ ...orgThemesQuery(orgId), retry: false })).resolved;
    return themeIcons(theme, await parentIcons(parent));
  } catch {
    return {};
  }
}

/** The public pages' metadata: the platform default theme's icon. */
export async function platformThemeMetadata(
  _props?: unknown,
  parent?: ResolvingMetadata,
): Promise<Metadata> {
  try {
    return themeIcons(
      await serverQueryClient().fetchQuery({ ...platformThemeQuery(), retry: false }),
      await parentIcons(parent),
    );
  } catch {
    return {};
  }
}
