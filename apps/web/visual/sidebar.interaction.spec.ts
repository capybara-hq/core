import { expect, type Page, test } from "@playwright/test";

/**
 * Sidebar interaction (design spec §6.11, §6.13; §9.5): keyboard path, group collapse motion and
 * its reduced-motion form, the rail's drawer. Runs on the live `/dev/ui/reference/sidebar`
 * blocks. The viewport cases (rail below 1280, drawer below 960, no horizontal page scroll) need
 * the full shell: they run on `/dev/ui/templates/list` once its FixtureShell is on AppShell.
 */
const block = (page: Page, id: string) => page.locator(`[data-ref-block="${id}"]`);

async function open(page: Page) {
  await page.goto("/zh/dev/ui/reference/sidebar");
  await page.waitForLoadState("networkidle");
}

test("keyboard: Tab enters the nav at the current item, ↓ moves, Enter follows the link", async ({
  page,
}) => {
  await open(page);
  const b = block(page, "sidebar-default");
  await b.getByRole("button", { name: /搜索/ }).focus();
  await page.keyboard.press("Tab");
  await expect(b.getByRole("link", { name: "Agents" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(b.getByRole("link", { name: /^收件箱/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/at=inbox/);
});

test("group collapse animates its height over motion.expand", async ({ page }) => {
  await open(page);
  const b = block(page, "sidebar-default");
  const toggle = b.getByRole("button", { name: "研究助手", exact: true });
  const body = b.locator('[data-part="group-body"]').first();
  expect(await body.evaluate((e) => getComputedStyle(e).transitionDuration)).toBe("0.16s");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => body.evaluate((e) => e.getBoundingClientRect().height)).toBe(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // Leave the viewer's storage as it was for the other cases.
  await page.evaluate(() => localStorage.removeItem("cap.sidebar.collapsed"));
});

test("reduced motion: the collapse is instant", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const body = block(page, "sidebar-default").locator('[data-part="group-body"]').first();
  const seconds = await body.evaluate((e) =>
    Number.parseFloat(getComputedStyle(e).transitionDuration),
  );
  expect(seconds * 1000).toBeLessThanOrEqual(0.01);
});

test("rail: expand opens the drawer; Esc closes it and returns focus", async ({ page }) => {
  await open(page);
  const b = block(page, "sidebar-rail");
  // Icons only: no visible labels in the rail.
  await expect(b.locator('[data-part="nav-item"] .cb-sidebar-label')).toHaveCount(0);
  const expand = b.getByRole("button", { name: "展开侧栏" });
  // The sidebar-drawer block draws one drawer in place (the open modal hides it from the
  // accessibility tree), so count the elements; the modal one is the last.
  const dialogs = page.locator('[role="dialog"]');
  await expect(dialogs).toHaveCount(1);
  await expand.click();
  await expect(dialogs).toHaveCount(2);
  const drawer = dialogs.last();
  await expect(drawer.getByRole("region", { name: "会话" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialogs).toHaveCount(1);
  await expect(expand).toBeFocused();
});

test("long titles truncate inside the 256 sidebar", async ({ page }) => {
  await open(page);
  const b = block(page, "sidebar-long-title");
  const sidebar = b.locator('[data-part="sidebar"]');
  expect(await sidebar.evaluate((e) => e.getBoundingClientRect().width)).toBe(256);
  const row = b.locator('[data-part="conversation"][aria-current="page"]');
  const fits = await row.evaluate((e) => {
    const label = e.firstElementChild as HTMLElement;
    return {
      clipped: label.scrollWidth > label.clientWidth,
      width: e.getBoundingClientRect().width,
    };
  });
  expect(fits.clipped).toBe(true);
  expect(fits.width).toBeLessThanOrEqual(256);
});

// Viewport cases: enabled when /dev/ui/templates/list renders the Sidebar shell (AppShell).
test.describe("viewport widths (full shell)", () => {
  test.fixme(true, "needs the FixtureShell on AppShell (UI refresh A, Task 10)");
  for (const width of [1440, 1279, 959, 640]) {
    test(`no horizontal page scroll at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/zh/dev/ui/templates/list");
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
    });
  }
  test("1279: the rail shows icons only", async ({ page }) => {
    await page.setViewportSize({ width: 1279, height: 900 });
    await page.goto("/zh/dev/ui/templates/list");
    await expect(page.locator('[data-part="sidebar"][data-mode="rail"]')).toBeVisible();
    await expect(page.getByRole("navigation", { name: "主导航" }).getByText("Agents")).toHaveCount(
      0,
    );
  });
  test("959: the menu button opens the drawer; Esc closes it, focus returns", async ({ page }) => {
    await page.setViewportSize({ width: 959, height: 900 });
    await page.goto("/zh/dev/ui/templates/list");
    const menu = page.getByRole("button", { name: "打开导航" });
    await menu.click();
    await expect(page.getByRole("dialog", { name: "主导航" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
  });
});
