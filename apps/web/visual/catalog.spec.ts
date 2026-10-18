import { expect, type Page, test } from "@playwright/test";
import { CATALOG_ROUTES } from "../src/dev/catalog/routes";

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/** 额外在窄屏各截一张的路由（Inspector → Sheet、Rail → 筛选按钮的断点）。 */
const NARROW: Record<string, number[]> = {
  "templates/list": [1024, 900],
  "templates/detail": [1024, 900],
};

const shotName = (route: string, theme: Theme, suffix = "") =>
  `${route.replaceAll("/", "-")}${suffix}-${theme}.png`;

async function open(page: Page, route: string, theme: Theme, width = 1440) {
  await page
    .context()
    .addCookies([{ name: "cb-theme", value: theme, url: "http://localhost:3100" }]);
  await page.setViewportSize({ width, height: 900 });
  if (route === "overlays/toast") await page.clock.install();
  await page.goto(`/zh/dev/ui/${route}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await prepare(page, route);
}

/** 只能靠交互打开的浮层，在截图前打开；需要定格的计时在此暂停。 */
async function prepare(page: Page, route: string) {
  if (route.startsWith("overlays/") && route !== "overlays/menu" && route !== "overlays/toast") {
    await expect(page.getByRole("dialog").first()).toBeVisible();
  }
  if (route === "overlays/menu") {
    await page.getByRole("button", { name: "行操作" }).first().click();
    await expect(page.getByRole("menu")).toBeVisible();
  }
  if (route === "overlays/toast") {
    await expect(page.getByRole("alert").filter({ hasText: "终止失败" })).toBeVisible();
    // 成功 Toast 4s 后自动消失：把假时钟停在当前时刻，截图期间不再触发计时器。
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1));
  }
}

for (const theme of THEMES) {
  test.describe(theme, () => {
    for (const route of CATALOG_ROUTES) {
      test(route, async ({ page }) => {
        await open(page, route, theme);
        await expect(page).toHaveScreenshot(shotName(route, theme), { fullPage: true });
        for (const width of NARROW[route] ?? []) {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate(() => document.fonts.ready);
          await expect(page).toHaveScreenshot(shotName(route, theme, `-${width}`), {
            fullPage: true,
          });
        }
      });
    }

    // 悬停 / 焦点 / 按下等交互态无法静态渲染，裁剪到元素截图。
    test("交互：悬停主按钮", async ({ page }) => {
      await open(page, "components", theme);
      const button = page.getByRole("button", { name: "新建 Agent" }).first();
      await button.hover();
      await expect(button).toHaveScreenshot(shotName("hover-primary-button", theme));
    });

    test("交互：键盘聚焦输入框", async ({ page }) => {
      await open(page, "components", theme);
      const input = page.getByLabel("Agent 名称").first();
      await input.focus();
      const field = input.locator("xpath=ancestor::div[contains(@class, 'cb-field')][1]");
      await expect(field).toHaveScreenshot(shotName("focus-input", theme));
    });

    test("交互：悬停表格行", async ({ page }) => {
      await open(page, "table", theme);
      const row = page.getByRole("row", { name: /run_8f2k1x/ }).first();
      await row.hover();
      await expect(row).toHaveScreenshot(shotName("hover-table-row", theme));
    });

    test("交互：打开行内 ⋯ 菜单", async ({ page }) => {
      await open(page, "table", theme);
      const row = page.getByRole("row", { name: /run_8f2jh8/ }).first();
      await row.getByRole("button", { name: "行操作" }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveScreenshot(shotName("row-menu", theme));
    });

    test("交互：筛选 Popover", async ({ page }) => {
      await open(page, "overlays/menu", theme);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "状态: 2 项 ▾" }).click();
      const pop = page.getByRole("dialog");
      await expect(pop).toBeVisible();
      await expect(page).toHaveScreenshot(shotName("filter-popover", theme), { fullPage: true });
    });

    test("交互：危险确认输入名称后", async ({ page }) => {
      await open(page, "overlays/danger", theme);
      await page.getByRole("dialog").getByRole("textbox").fill("support-triage");
      await expect(page.getByRole("button", { name: "删除" })).toBeEnabled();
      await expect(page).toHaveScreenshot(shotName("danger-matched", theme), { fullPage: true });
    });
  });
}
