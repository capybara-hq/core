import type { Locator, Page } from "@playwright/test";

/**
 * A link of the sidebar's main navigation: the items under 更多 (collapsed unless the current page
 * is inside it, or remembered open) need the group opened first.
 */
export async function mainNavLink(page: Page, name: string): Promise<Locator> {
  const nav = page.getByRole("navigation", { name: "主导航" });
  const link = nav.getByRole("link", { name, exact: true });
  const more = nav.getByRole("button", { name: "更多", exact: true });
  if ((await more.count()) > 0 && (await more.getAttribute("aria-expanded")) === "false")
    await more.click();
  return link;
}
