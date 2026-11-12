import { expect, type Page, test } from "@playwright/test";

/**
 * The scheduled tasks calendar page (calendar spec §11): the real `/schedules` calendar view drawn
 * from a seeded query cache at `/dev/ui/pages/schedules-calendar[-month|-admin]` (no kernel), with
 * the clock fixed at Thursday 2026-11-12 10:24 in Asia/Shanghai. Baselines: the week and the month
 * at the desktop width, the admin's 全组织, the open run panel and the phone's agenda (390), dark
 * and light; rendered only by the `visual-update` workflow. Then the keyboard path and, with
 * JavaScript off, the phone's first paint without a horizontal scroll.
 */
const THEMES = ["dark", "light"] as const;
const PORT = process.env.CAPYBARA_VISUAL_PORT ?? "3100";

test.use({ timezoneId: "Asia/Shanghai" });

async function open(
  page: Page,
  route: string,
  opts: { theme?: (typeof THEMES)[number]; width?: number; hash?: string } = {},
) {
  await page
    .context()
    .addCookies([
      { name: "cb-theme", value: opts.theme ?? "dark", url: `http://localhost:${PORT}` },
    ]);
  await page.clock.setFixedTime(new Date("2026-11-12T10:24:00+08:00"));
  await page.setViewportSize({ width: opts.width ?? 1440, height: 900 });
  await page.goto(`/dev/ui/pages/${route}${opts.hash ?? ""}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  const part = (opts.width ?? 1440) < 640 ? "schedule-calendar-row" : "schedule-calendar-block";
  await expect(page.locator(`[data-part="${part}"]:visible`).first()).toBeVisible();
}

const CASES = [
  { name: "week-1440", route: "schedules-calendar" },
  { name: "month-1440", route: "schedules-calendar-month" },
  { name: "admin-1440", route: "schedules-calendar-admin" },
  // the failed run of Monday 14:00, opened from the hash
  { name: "sheet-1440", route: "schedules-calendar", hash: "#run=tr5" },
  { name: "agenda-390", route: "schedules-calendar", width: 390 },
] as const;

for (const theme of THEMES) {
  for (const c of CASES) {
    test(`schedules calendar ${c.name} ${theme}`, async ({ page }) => {
      await open(page, c.route, {
        theme,
        ...("width" in c ? { width: c.width } : {}),
        ...("hash" in c ? { hash: c.hash } : {}),
      });
      if ("hash" in c) await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page).toHaveScreenshot(`schedules-calendar-${c.name}-${theme}.png`, {
        fullPage: true,
      });
    });
  }
}

test("keyboard: one tab stop, arrows move between runs, Enter opens the run panel", async ({
  page,
}) => {
  await open(page, "schedules-calendar");
  const grid = page.locator('[data-part="schedule-calendar-grid"]');
  const stop = grid.locator('[tabindex="0"]');
  await expect(stop).toHaveCount(1);
  await stop.focus();
  // today's first item holds the tab stop (Thursday: the hourly chip of the dense lane)
  const first = await page.evaluate(() => document.activeElement?.getAttribute("data-key"));
  expect(first).toBe("c:day=s4/2026-11-12");
  await page.keyboard.press("ArrowDown");
  const second = await page.evaluate(() => document.activeElement?.getAttribute("data-key"));
  expect(second).not.toBe(first);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/#(run|at)=/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).not.toHaveURL(/#/);
});

test.describe("first paint without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("a phone paints the agenda, never the grid, with no horizontal page scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dev/ui/pages/schedules-calendar");
    await expect(page.locator('[data-part="schedule-calendar-agenda"]')).toBeVisible();
    await expect(page.locator('[data-part="schedule-calendar-grid"]')).toBeHidden();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
