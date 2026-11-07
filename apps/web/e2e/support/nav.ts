import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The workspace home, the new conversation (`/`, no query; `/chat` redirects there, maintainer
 * decision 2026-11-07), as a full URL.
 */
export const HOME_URL = /^https?:\/\/[^/]+\/$/;
/** The new conversation with an agent picked (`/?agent=<id>`), as a full URL. */
export const NEW_CHAT_URL = /^https?:\/\/[^/]+\/\?agent=[^&]+$/;

/**
 * A link of the sidebar's navigation: a main item directly, or an item of the 更多 flyout (a menu
 * to the right of the sidebar), which is opened first.
 */
export async function mainNavLink(page: Page, name: string): Promise<Locator> {
  const nav = page.getByRole("navigation", { name: "主导航" });
  const link = nav.getByRole("link", { name, exact: true });
  if ((await link.count()) > 0) return link;
  await nav.getByRole("button", { name: "更多", exact: true }).click();
  return page.getByRole("menu", { name: "更多" }).getByRole("menuitem", { name, exact: true });
}

/**
 * Until hydration the sidebar draws its full and its rail panel (CSS media queries show one); a
 * locator into it is unique only after that, so wait for the hydrated sidebar before reading it.
 */
export async function hydrated(page: Page): Promise<void> {
  await expect(page.locator('[data-part="sidebar"][data-responsive="true"]')).toHaveCount(0);
}
