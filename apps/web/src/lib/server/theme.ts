import "server-only";
import { parseTheme, THEME_COOKIE } from "@capybara-hq/design/theme";
import type { Metadata, Viewport } from "next";
import type { PlatformMeta } from "../app-auth";
import { platformMetaQuery } from "../query/app-auth";
import { meQuery } from "../query/shell";
import { orgThemesQuery, platformThemeQuery } from "../query/themes";
import type { ThemeRef } from "../themes";
import { type PlatformIcons, platformIconsMetadata, themeColorOf } from "../web-manifest";
import { currentCookie } from "./page";
import { serverQueryClient } from "./query";

/**
 * The page icons of a route-group layout (themes spec §4.3, theme brand coverage spec §5): the
 * platform icons with `icon` always set, to the resolved theme's favicon, else the platform's (the
 * upload, else the web's). Next replaces `icons` whole, and setting `icon` every time means the
 * root layout's brand-cookie favicon (a hint) never outlives the document's own answer.
 */
export function themeIcons(theme: ThemeRef | null, base: PlatformIcons): Metadata {
  return { icons: { ...base, icon: theme?.logo?.faviconUrl ?? base.icon } };
}

/** The platform icons (upload > platform default theme > built-in); never throws. */
async function platformIcons(): Promise<PlatformIcons> {
  const qc = serverQueryClient();
  const [meta, theme] = await Promise.all([
    qc.fetchQuery({ ...platformMetaQuery(), retry: false }).catch((): PlatformMeta | null => null),
    qc.fetchQuery({ ...platformThemeQuery(), retry: false }).catch((): ThemeRef | null => null),
  ]);
  return platformIconsMetadata(meta, theme);
}

/** The browser colour of the scheme this document renders (`cb-theme`) under `theme`. */
async function themeViewport(theme: ThemeRef | null): Promise<Viewport> {
  const scheme = parseTheme(await currentCookie(THEME_COOKIE));
  return { themeColor: themeColorOf(scheme, theme?.background ?? null) };
}

/**
 * The viewer's resolved theme as the workspace layout reads it. The reads go through the request's
 * query client, so they are the ones the layout's shell read makes (one kernel call each).
 */
async function workspaceTheme(): Promise<ThemeRef | null> {
  const qc = serverQueryClient();
  const me = await qc.fetchQuery({ ...meQuery(), retry: false });
  const orgId = me.memberships.some((m) => m.orgId === me.currentOrgId) ? me.currentOrgId : null;
  return orgId === null
    ? await qc.fetchQuery({ ...platformThemeQuery(), retry: false })
    : (await qc.fetchQuery({ ...orgThemesQuery(orgId), retry: false })).resolved;
}

/**
 * The workspace layout's metadata: the viewer's theme icon. A failed read leaves the root layout's
 * icons (the layout then draws the starting frame or the root error page, under the brand cookie).
 */
export async function workspaceThemeMetadata(): Promise<Metadata> {
  try {
    return themeIcons(await workspaceTheme(), await platformIcons());
  } catch {
    return {};
  }
}

/** The workspace layout's viewport: the viewer's theme's page colour (a failed read: the root's). */
export async function workspaceViewport(): Promise<Viewport> {
  try {
    return await themeViewport(await workspaceTheme());
  } catch {
    return {};
  }
}

/** The platform default theme, null when it cannot be read (the auth layout draws the built-in). */
const platformTheme = (): Promise<ThemeRef | null> =>
  serverQueryClient()
    .fetchQuery({ ...platformThemeQuery(), retry: false })
    .catch(() => null);

/** The public pages' metadata: the platform default theme's icon (always set). */
export async function platformThemeMetadata(): Promise<Metadata> {
  return themeIcons(await platformTheme(), await platformIcons());
}

/** The public pages' viewport: the platform default theme's page colour, else the built-in. */
export async function platformViewport(): Promise<Viewport> {
  return themeViewport(await platformTheme());
}
