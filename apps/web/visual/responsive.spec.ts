import { expect, type Page, test } from "@playwright/test";
import { MEMBER_PAGES, TEMPLATE_ROUTES } from "../src/dev/catalog/routes";
import { findSmallTargets } from "./mobile-sizes";
import { heightFor } from "./size-matrix";

/**
 * The responsive visual matrix (responsive system spec §7, plan decision P4): every template's
 * catalog page at three widths, one per size class, in both themes: 390 on a touch device (compact:
 * `isMobile` and `hasTouch`, so the touch forms draw), 768 (medium) and 1440 (expanded). The
 * baselines come from the `visual-update` workflow; until it has run a new shot has none and is
 * the only failure.
 *
 * Also the hit-size guard of the compact rule set: at 390 every control the mobile sizes cover is
 * a 44 x 44 tap target, with a touch device and with a fine pointer alike (maintainer decision
 * 2026-11-22). `compact.interaction.spec.ts` runs the same measurement at more widths and with
 * JavaScript off; this one keeps it next to the screenshots of the same pages.
 */
const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

const WIDTHS = [
  { width: 390, touch: true },
  { width: 768, touch: false },
  { width: 1440, touch: false },
] as const;

const ORIGIN = `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`;

/** A member page's route: the real view drawn from a seeded cache (`member-pages.tsx`). */
const memberRoute = (p: string) => `pages/member-${p}`;

async function open(page: Page, route: string, theme: Theme) {
  await page.context().addCookies([{ name: "cb-theme", value: theme, url: ORIGIN }]);
  await page.goto(`/dev/ui/${route}`);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

for (const theme of THEMES) {
  for (const { width, touch } of WIDTHS) {
    test.describe(`responsive ${width}${touch ? " touch" : ""} ${theme}`, () => {
      test.use({
        viewport: { width, height: heightFor(width) },
        isMobile: touch,
        hasTouch: touch,
      });

      for (const route of TEMPLATE_ROUTES) {
        test(route, async ({ page }) => {
          await open(page, route, theme);
          await expect(page).toHaveScreenshot(
            `responsive-${route.replaceAll("/", "-")}-${width}-${theme}.png`,
            { fullPage: true },
          );
        });
      }

      // The member pages (agents, skills, connectors, schedules' list, conversations, inbox and
      // the account profile): the real views at a member's role from a seeded query cache, so the
      // grouped rows, the row actions and the primaries draw as a person sees them.
      for (const p of MEMBER_PAGES) {
        test(`member ${p}`, async ({ page }) => {
          await open(page, memberRoute(p), theme);
          await expect(page).toHaveScreenshot(`responsive-member-${p}-${width}-${theme}.png`, {
            fullPage: true,
          });
        });
      }
    });
  }
}

for (const touch of [true, false]) {
  test.describe(`hit size 390 ${touch ? "touch" : "fine pointer"}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: touch, hasTouch: touch });

    for (const route of TEMPLATE_ROUTES) {
      test(route, async ({ page }) => {
        await open(page, route, "dark");
        const small = await findSmallTargets(page);
        expect(small.out, "controls without a 44 x 44 hit box").toEqual([]);
      });
    }

    // the member pages: the same 44 x 44 rule on the real views
    for (const p of MEMBER_PAGES) {
      test(`member ${p}`, async ({ page }) => {
        await open(page, memberRoute(p), "dark");
        const small = await findSmallTargets(page);
        expect(small.out, "controls without a 44 x 44 hit box").toEqual([]);
      });
    }
  });
}
