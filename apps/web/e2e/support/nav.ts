import type { Locator, Page } from "@playwright/test";

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
