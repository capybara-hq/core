import { pluginTabs } from "../../lib/admin-tabs";
import { evalsTabs } from "../../lib/evals-tabs";
import { adminItemTabs } from "../admin-item-tabs";
import { ADMIN_PAGES } from "../admin-nav";
import { ACCOUNT_HREFS, ORG_SETTINGS_HREFS } from "../settings-nav";
import { NAV_HREFS } from "./nav";

/**
 * The first level of the app's navigation (spec §4.2 path rule, maintainer decision 2026-11-29):
 * every page the sidebar reaches directly. The sidebar's items and its 更多 menu, the new
 * conversation, the inbox and all conversations, the account menu's personal settings, the admin
 * console's nav; their header tabs (routed tabs inherit their head's level) and their settings
 * sub-nav items (siblings of the first). A first-level page draws no path row; every other page
 * (an item, a create or import flow) is deeper and draws it. Extension pages (`/p/…`,
 * `/admin/p/…`) are first-level as the nav opens them (no page params); the plugin page host makes
 * one with params deeper.
 */
export const FIRST_LEVEL_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/inbox",
  "/conversations",
  ...NAV_HREFS,
  ...ORG_SETTINGS_HREFS,
  ...ACCOUNT_HREFS,
  ...ADMIN_PAGES.map((p) => p.href),
  ...(["agents", "connectors"] as const).flatMap((k) =>
    adminItemTabs(k, "items", { items: "", templates: "" }).tabs.map((t) => t.href ?? ""),
  ),
  ...pluginTabs(() => "").map((t) => t.href),
  ...evalsTabs(() => "").map((t) => t.href),
]);

/** Extension pages: the nav opens them; the plugin page host decides by their params. */
const EXTENSION_PAGE = /^\/(admin\/)?p\/[^/]+\/[^/]+$/;

/** The navigation level of the page at `pathname` (no query, no locale prefix). */
export function pathLevel(pathname: string): "first" | "deeper" {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return FIRST_LEVEL_ROUTES.has(path) || EXTENSION_PAGE.test(path) ? "first" : "deeper";
}
