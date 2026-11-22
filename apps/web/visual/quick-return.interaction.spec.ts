import { expect, type Page, test } from "@playwright/test";

/**
 * The compact quick-return bar (responsive system spec §2.6, design spec §6.65) and the compact
 * toast place (interaction model §7, D2 as amended 2026-11-23), measured on the conversations page
 * of the member matrix (`pages/member-conversations`) at 390 on touch and at 480 with a fine
 * pointer inside a fake desktop shell with window controls (the flat title bar). The window is
 * short, so the list scrolls.
 *
 * - Scrolled to the end and back up a little, the bar is back, docked right under the top row: its
 *   top is the bottom of the row's strip, with nothing of the list between them (issue #642: the
 *   sticky offset counted the row twice and left a row-high gap the rows showed through).
 * - A toast sits under the top row, a space.2 gap below it, inside the side gutters.
 *
 * No screenshots: this spec writes no baselines.
 */
const MODES = [
  { name: "390 touch", width: 390, touch: true, desktop: false },
  { name: "480 desktop shell", width: 480, touch: false, desktop: true },
] as const;
const HEIGHT = 480;

/** The bottom of the top row's strip (the shell column's `::before`, `--cb-float-row` high). */
async function rowBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const col = document.querySelector(".cb-shell-column") as HTMLElement;
    return (
      col.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(col, "::before").height)
    );
  });
}

for (const mode of MODES) {
  test.describe(mode.name, () => {
    test.use({
      viewport: { width: mode.width, height: HEIGHT },
      isMobile: mode.touch,
      hasTouch: mode.touch,
      reducedMotion: "reduce",
    });

    test.beforeEach(async ({ page }) => {
      if (mode.desktop) {
        await page.addInitScript(() => {
          (window as unknown as { capybaraShell: unknown }).capybaraShell = {
            version: 1,
            kind: "desktop",
            platform: "macos",
            on: () => () => {},
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
            controls: { x: 0, y: 0, width: 76, height: 40 },
            capabilities: {},
          };
        });
      }
      await page.goto("/dev/ui/pages/member-conversations");
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
    });

    test("the bar comes back docked under the top row, nothing of the list above it", async ({
      page,
    }) => {
      const bar = page.locator('[data-part="list-compact-bar"]');
      await expect(bar).toBeVisible();
      const scroller = page.locator('.cb-template[data-scroll="one"]').first();
      const box = await scroller.boundingBox();
      if (!box) throw new Error("no scroller");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // down to the end: the bar slides away
      const range = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(range, "the list scrolls").toBeGreaterThan(100);
      await page.mouse.wheel(0, range + 200);
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop))
        .toBeLessThan(2);
      await expect(page.locator('.cb-template[data-bar-hidden="true"]')).toHaveCount(1);
      // back up a little: still far from the top, and the bar is back
      await page.mouse.wheel(0, -40);
      await expect(page.locator('.cb-template[data-bar-hidden="true"]')).toHaveCount(0);
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(60);

      const row = await rowBottom(page);
      const top = await bar.evaluate((el) => el.getBoundingClientRect().top);
      expect(Math.abs(top - row), `bar top ${top} at the row's bottom ${row}`).toBeLessThanOrEqual(
        1,
      );
      // its ground is opaque, and nothing paints between the row and the bar or over the bar's top
      expect(await bar.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(
        /rgba\(.*, 0\)|transparent/,
      );
      const hits = await page.evaluate(
        ({ y, x }) => {
          const at = document.elementFromPoint(x, y);
          return {
            inBar: at?.closest('[data-part="list-compact-bar"]') != null,
            row: at?.closest(".cb-convlist-section, .cb-convlist-card") != null,
          };
        },
        { y: row + 1, x: mode.width - 8 },
      );
      expect(hits.inBar, "the point just under the row is the bar").toBe(true);
      expect(hits.row, "no list row shows above the bar").toBe(false);
    });

    test("a toast sits under the top row, inside the gutters", async ({ page }) => {
      // a toast the provider draws: copy one into the page's region (the page fires none itself)
      await page.evaluate(() => {
        const group = document.querySelector('.cb-toast-group[data-group="status"]');
        const t = document.createElement("div");
        t.className = "cb-toast";
        t.setAttribute("data-kind", "success");
        t.innerHTML =
          '<span class="cb-toast-icon"></span><div class="cb-toast-head"><span class="cb-toast-msg">已保存。</span></div>';
        group?.append(t);
      });
      const toast = page.locator(".cb-toast").first();
      await expect(toast).toBeVisible();
      const r = await toast.boundingBox();
      if (!r) throw new Error("no toast box");
      const row = await rowBottom(page);
      // space.2 under the row, never over it
      expect(Math.abs(r.y - (row + 8)), `toast top ${r.y}, row bottom ${row}`).toBeLessThanOrEqual(
        1,
      );
      expect(r.x).toBeCloseTo(16, 0);
      expect(r.x + r.width).toBeCloseTo(mode.width - 16, 0);
    });
  });
}
