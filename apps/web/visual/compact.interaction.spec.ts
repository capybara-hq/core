import { expect, type Page, test } from "@playwright/test";
import { TEMPLATE_ROUTES } from "../src/dev/catalog/routes";
import { findSmallTargets, findTallPadding } from "./mobile-sizes";

/**
 * The geometric half of the compact rule set (mobile layout spec §11.3): every template's catalog
 * page at the two phone widths (382: the iPhone Duo outer display, 390) on a coarse pointer, and at
 * 480 with a fine pointer (a narrowed desktop window: the mobile sizes follow the width too, design
 * spec §2.5, maintainer decision 2026-11-22), with JavaScript on and off (the first paint):
 *
 * - no horizontal page scroll;
 * - every control the mobile sizes cover (buttons, chips, tabs, segments, text fields, selects, the
 *   floating and title bar buttons) has a 44 x 44 hit box (`touch.hit`); the others are counted;
 * - every one of those controls with text pads wider than it is tall from its text;
 * - the primary action is reachable (inside the window) after a vertical scroll;
 * - text fields are at least 16 px (a smaller one makes iOS zoom the page on focus).
 *
 * The measurements are `mobile-sizes.ts` (proven red in `mobile-sizes.interaction.spec.ts`); the
 * structural half is `findCompactViolations` in packages/design (jsdom). No screenshots: this spec
 * writes no baselines.
 */
const MODES = [
  { width: 382, touch: true },
  { width: 390, touch: true },
  { width: 480, touch: false },
] as const;
const HEIGHT = 844;

async function openCompact(page: Page, route: string) {
  await page.context().addCookies([
    {
      name: "cb-theme",
      value: "dark",
      url: `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`,
    },
  ]);
  await page.goto(`/dev/ui/${route}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/** Scrolls whatever scrolls (the document, or the shell's main region) to its end. */
async function scrollToEnd(page: Page) {
  await page.evaluate(() => {
    const els = [document.scrollingElement, ...Array.from(document.querySelectorAll("*"))];
    for (const el of els) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
    }
  });
}

for (const javaScriptEnabled of [true, false]) {
  for (const { width, touch } of MODES) {
    const pointer = touch ? "touch" : "fine pointer";
    test.describe(`compact ${width} ${pointer} ${javaScriptEnabled ? "js on" : "js off"}`, () => {
      test.use({
        viewport: { width, height: HEIGHT },
        isMobile: touch,
        hasTouch: touch,
        javaScriptEnabled,
      });

      for (const route of TEMPLATE_ROUTES) {
        test(route, async ({ page }) => {
          await openCompact(page, route);

          // no horizontal page scroll
          const overflow = await page.evaluate(() => ({
            scroll: document.scrollingElement?.scrollWidth ?? 0,
            inner: window.innerWidth,
          }));
          expect(overflow.scroll, "scrollWidth <= innerWidth").toBeLessThanOrEqual(overflow.inner);

          // every control the mobile sizes cover has a 44 x 44 hit box
          const small = await findSmallTargets(page);
          if (small.census.length > 0) {
            test.info().annotations.push({
              type: "hit-census",
              description: `${small.census.length} controls without a stated tap target: ${small.census.join("; ")}`,
            });
          }
          expect(small.out, "controls without a 44 x 44 hit box").toEqual([]);

          // a control with text pads wider than it is tall
          expect(await findTallPadding(page), "text controls padded taller than wide").toEqual([]);

          // text fields are at least 16 px under the mobile sizes
          const fonts = await page.evaluate(() =>
            Array.from(
              document.querySelectorAll(
                "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select",
              ),
            )
              .filter((el) => getComputedStyle(el).display !== "none")
              .map((el) => ({
                name: el.getAttribute("aria-label") ?? el.getAttribute("name") ?? el.tagName,
                px: Number.parseFloat(getComputedStyle(el).fontSize),
              }))
              .filter((f) => f.px < 16),
          );
          expect(fonts, "text fields under 16 px").toEqual([]);

          await scrollToEnd(page);

          // the primary action is inside the window after the scroll (the inbox's decision row is
          // under the open item only: with the list showing it is not drawn)
          const primary = page.locator('[data-part="action-primary"]:visible').first();
          if ((await primary.count()) > 0) {
            const box = await primary.boundingBox();
            expect(box, "the primary action has a box").not.toBeNull();
            if (box) {
              expect(box.x).toBeGreaterThanOrEqual(0);
              expect(box.x + box.width).toBeLessThanOrEqual(width);
              expect(box.y).toBeGreaterThanOrEqual(0);
              expect(box.y + box.height).toBeLessThanOrEqual(HEIGHT);
            }
          }
        });
      }
    });
  }
}
