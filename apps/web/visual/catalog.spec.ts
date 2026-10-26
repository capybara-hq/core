import { expect, type Page, test } from "@playwright/test";
import { CATALOG_ROUTES } from "../src/dev/catalog/routes";

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/** 额外在窄屏各截一张的路由（Inspector → Sheet、Rail → 筛选按钮的断点）。 */
const NARROW: Record<string, number[]> = {
  "templates/list": [1279, 959],
  "templates/form": [959],
  "templates/detail": [1024, 900],
};

const shotName = (route: string, theme: Theme, suffix = "") =>
  `${route.replaceAll("/", "-")}${suffix}-${theme}.png`;

async function open(page: Page, route: string, theme: Theme, width = 1440) {
  await page.context().addCookies([
    {
      name: "cb-theme",
      value: theme,
      url: `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`,
    },
  ]);
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
    // 假时钟在读时间与暂停之间仍在走，机器慢时目标时刻可能已过去，失败就重读再试。
    for (let attempt = 1; ; attempt++) {
      try {
        await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
        break;
      } catch (e) {
        if (attempt >= 5) throw e;
      }
    }
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

    test("交互：按下主按钮", async ({ page }) => {
      await open(page, "components", theme);
      const button = page.getByRole("button", { name: "新建 Agent" }).first();
      await button.hover();
      // 只按下不松开，定格 :active 态
      await page.mouse.down();
      await expect(button).toHaveScreenshot(shotName("pressed-primary-button", theme));
      await page.mouse.up();
    });

    test("交互：Tooltip 打开", async ({ page }) => {
      await open(page, "components", theme);
      const trigger = page.getByRole("button", { name: /提示 Tooltip/ });
      // role=tooltip 是 Radix 给读屏的隐藏副本，可见的提示框是 .cb-tooltip
      const tip = page.locator(".cb-tooltip");
      // 机器繁忙时首次悬停可能早于水合完成而丢失：移开再悬停，直到提示框出现
      await expect(async () => {
        await page.mouse.move(0, 0);
        await trigger.hover();
        await expect(tip).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 20_000 });
      // 出现动画（淡入 + 4px 位移）结束后再量位置，否则提示框还在移动
      await tip.evaluate((el) =>
        Promise.all(el.getAnimations({ subtree: true }).map((x) => x.finished)),
      );
      // 浮层在 Portal 中：裁剪到触发按钮与提示框的并集（外扩 8）
      const a = await trigger.boundingBox();
      const b = await tip.boundingBox();
      if (!a || !b) throw new Error("tooltip 或触发按钮不可见");
      // 取整到整像素，否则小数坐标会让裁剪尺寸在 68 / 69 之间跳动
      const x = Math.floor(Math.min(a.x, b.x) - 8);
      const y = Math.floor(Math.min(a.y, b.y) - 8);
      const clip = {
        x,
        y,
        width: Math.ceil(Math.max(a.x + a.width, b.x + b.width) + 8) - x,
        height: Math.ceil(Math.max(a.y + a.height, b.y + b.height) + 8) - y,
      };
      await expect(page).toHaveScreenshot(shotName("tooltip-open", theme), { clip });
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
      await page.getByRole("button", { name: "状态: 2 项" }).click();
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
