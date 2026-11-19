import { expect, type Page, test } from "@playwright/test";
import { heightFor, MATRIX_WIDTHS } from "./size-matrix";

/**
 * The admin console overview (spec 2026-11-11-admin-overview-design.md §7.3, §10.3): the real page
 * drawn from a seeded query cache at `/dev/ui/pages/admin-overview` (no kernel), at the width
 * matrix of mobile layout spec §11.1 (382, 390 and 768 phone and medium: StatCards 2 × 2, the
 * sections stacked, the audit table's rows stacked; 951 and 1440), dark and light. Baselines are
 * rendered only by the `visual-update` workflow.
 */
const THEMES = ["dark", "light"] as const;
const WIDTHS = MATRIX_WIDTHS;

async function open(page: Page, theme: (typeof THEMES)[number], width: number) {
  await page.context().addCookies([
    {
      name: "cb-theme",
      value: theme,
      url: `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`,
    },
  ]);
  await page.setViewportSize({ width, height: heightFor(width) });
  await page.goto("/dev/ui/pages/admin-overview");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // a loaded section carries no data-state (only loading and error do)
  await expect(page.locator('[data-part="overview-section"]:not([data-state])')).toHaveCount(4);
}

for (const theme of THEMES) {
  for (const width of WIDTHS) {
    test(`admin overview ${theme} ${width}`, async ({ page }) => {
      await open(page, theme, width);
      await expect(page).toHaveScreenshot(`admin-overview-${width}-${theme}.png`, {
        fullPage: true,
      });
    });
  }
}
