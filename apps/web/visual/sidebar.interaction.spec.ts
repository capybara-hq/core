import { expect, type Page, test } from "@playwright/test";

/**
 * Sidebar interaction (design spec §6.11, §6.13; §9.5): keyboard path, group collapse motion and
 * its reduced-motion form, the rail's drawer. Runs on the live `/dev/ui/reference/sidebar`
 * blocks. The viewport cases (rail below 1280, drawer below 960, no horizontal page scroll, the
 * first paint) run on `/dev/ui/templates/list`, whose FixtureShell is the AppShell.
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
  // No height motion until the viewer toggles: the remembered state applies without it.
  expect(await body.evaluate((e) => getComputedStyle(e).transitionDuration)).toBe("0s");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await body.evaluate((e) => getComputedStyle(e).transitionDuration)).toBe("0.16s");
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

test("Home / End go to the first and last nav item", async ({ page }) => {
  await open(page);
  const b = block(page, "sidebar-default");
  await b.getByRole("link", { name: "Agents" }).focus();
  await page.keyboard.press("End");
  await expect(b.getByRole("link", { name: "管理" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(b.getByRole("link", { name: "新会话" })).toBeFocused();
});

test("many groups: the conversation section scrolls on its own, the account stays pinned", async ({
  page,
}) => {
  await open(page);
  const b = block(page, "sidebar-many-groups");
  const section = b.getByRole("region", { name: "会话" });
  const m = await section.evaluate((e) => ({
    scroll: e.scrollHeight,
    client: e.clientHeight,
    overflow: getComputedStyle(e).overflowY,
  }));
  expect(m.overflow).toBe("auto");
  expect(m.scroll).toBeGreaterThan(m.client);
  const sidebar = b.locator('[data-part="sidebar"]');
  const account = b.locator('[data-part="account"]');
  const before = await account.boundingBox();
  await section.evaluate((e) => {
    e.scrollTop = e.scrollHeight;
  });
  const after = await account.boundingBox();
  const box = await sidebar.boundingBox();
  expect(after?.y).toBe(before?.y);
  // Pinned at the bottom: the footer ends inside the sidebar, within its padding.
  expect((box?.y ?? 0) + (box?.height ?? 0) - ((after?.y ?? 0) + (after?.height ?? 0))).toBe(12);
});

test("a long agent name truncates in its group toggle, full name in title", async ({ page }) => {
  await open(page);
  const b = block(page, "sidebar-long-title");
  const toggle = b.locator('[data-part="group-label"]').first();
  const fits = await toggle.evaluate((e) => {
    const label = e.querySelector(".cb-sidebar-label") as HTMLElement;
    return {
      clipped: label.scrollWidth > label.clientWidth,
      right: e.getBoundingClientRect().right,
      sidebarRight: (e.closest('[data-part="sidebar"]') as HTMLElement).getBoundingClientRect()
        .right,
      title: e.getAttribute("title") ?? "",
    };
  });
  expect(fits.clipped).toBe(true);
  expect(fits.right).toBeLessThanOrEqual(fits.sidebarRight);
  expect(fits.title.length).toBeGreaterThanOrEqual(20);
});

test("the open drawer traps Tab: focus cycles inside it", async ({ page }) => {
  await open(page);
  await block(page, "sidebar-rail").getByRole("button", { name: "展开侧栏" }).click();
  const drawer = page.locator('[role="dialog"]').last();
  await expect(drawer.getByRole("region", { name: "会话" })).toBeVisible();
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const inside = await drawer.evaluate((d) => d.contains(document.activeElement));
    expect(inside, `Tab ${i + 1} left the drawer`).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
});

test.describe("viewport widths (full shell)", () => {
  for (const width of [1440, 1279, 959, 640]) {
    test(`no horizontal page scroll at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/zh/dev/ui/templates/list");
      await page.waitForLoadState("networkidle");
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
    await expect(page.locator('[data-part="sidebar"][data-mode="full"]')).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "主导航" }).getByText("Agents")).toHaveCount(
      0,
    );
  });
  test("959: the menu button opens the drawer; Esc closes it, focus returns", async ({ page }) => {
    await page.setViewportSize({ width: 959, height: 900 });
    await page.goto("/zh/dev/ui/templates/list");
    await page.waitForLoadState("networkidle");
    const menu = page.getByRole("button", { name: "打开导航" });
    await menu.click();
    await expect(page.getByRole("dialog", { name: "主导航" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "主导航" })).toHaveCount(0);
    await expect(menu).toBeFocused();
  });
});

// The server render, before any script runs: CSS media queries pick the variant (no layout shift).
test.describe("first paint without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  const visibleModes = (page: Page) =>
    page.$$eval('[data-part="sidebar"]', (els) =>
      els.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.dataset.mode),
    );
  for (const [width, modes, bar] of [
    [1440, ["full"], false],
    [1279, ["rail"], false],
    [959, [], true],
    [640, [], true],
  ] as const) {
    test(`${width}: sidebar ${modes.join(",") || "hidden"}, drawer bar ${bar ? "shown" : "hidden"}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/zh/dev/ui/templates/list");
      expect(await visibleModes(page)).toEqual([...modes]);
      const barShown = await page
        .locator('[data-part="drawer-bar"]')
        .evaluate((e) => getComputedStyle(e).display !== "none");
      expect(barShown).toBe(bar);
      const { scroll, inner } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
      }));
      expect(scroll).toBeLessThanOrEqual(inner);
    });
  }

  // m6: below 640 the header's non-primary actions are folded at first paint, not after hydration.
  for (const [width, labels] of [
    [600, ["更多操作", "新建 Agent"]],
    [1440, ["导入", "导出", "新建 Agent"]],
  ] as const) {
    test(`${width}: the page header shows ${labels.join(" / ")}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/zh/dev/ui/templates/list");
      const shown = await page.$$eval(
        '[data-part="page-header"] .cb-pageheader-actions :is(button, a)',
        (els) =>
          els
            .filter((e) => e.getClientRects().length > 0)
            .map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim() ?? ""),
      );
      expect(shown).toEqual([...labels]);
    });
  }
});
