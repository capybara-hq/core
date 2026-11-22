import { expect, type Page, test } from "@playwright/test";
import {
  ADMIN_PAGES,
  MEMBER_PAGES,
  SUPER_ADMIN_PAGES,
  TEMPLATE_ROUTES,
} from "../src/dev/catalog/routes";
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

/**
 * An org admin page's route (`admin-pages.tsx`): desktop-only on touch, so a fine pointer at
 * every width.
 */
const orgRoute = (p: string) => `pages/org-${p}`;

/**
 * A super admin page's route (`super-admin-pages.tsx`): the console is desktop-only on touch, so a
 * fine pointer at every width.
 */
const platformRoute = (p: string) => `pages/platform-${p}`;

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

  // The org admin pages phase 2 changed (settings members, tokens, schedules, audit, extensions,
  // trajectories, evals with a set and a run): a fine pointer at every width, 390 included (they
  // have no touch form).
  for (const width of [390, 768, 1440]) {
    test.describe(`responsive org ${width} fine pointer ${theme}`, () => {
      test.use({ viewport: { width, height: heightFor(width) }, isMobile: false, hasTouch: false });

      for (const p of ADMIN_PAGES) {
        test(`org ${p}`, async ({ page }) => {
          await open(page, orgRoute(p), theme);
          await expect(page).toHaveScreenshot(`responsive-org-${p}-${width}-${theme}.png`, {
            fullPage: true,
          });
        });
      }
    });
  }

  // Three super admin pages (a list, a detail, a form): the same fine pointer at every width.
  for (const width of [390, 768, 1440]) {
    test.describe(`responsive platform ${width} fine pointer ${theme}`, () => {
      test.use({ viewport: { width, height: heightFor(width) }, isMobile: false, hasTouch: false });

      for (const p of SUPER_ADMIN_PAGES) {
        test(`platform ${p}`, async ({ page }) => {
          await open(page, platformRoute(p), theme);
          await expect(page).toHaveScreenshot(`responsive-platform-${p}-${width}-${theme}.png`, {
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

    // the org admin pages: the same 44 x 44 rule at 390 with a fine pointer (maintainer decision)
    if (!touch) {
      for (const p of ADMIN_PAGES) {
        test(`org ${p}`, async ({ page }) => {
          await open(page, orgRoute(p), "dark");
          const small = await findSmallTargets(page);
          expect(small.out, "controls without a 44 x 44 hit box").toEqual([]);
        });
      }

      // the super admin pages: the 44 x 44 rule and no horizontal page scroll at 390
      for (const p of SUPER_ADMIN_PAGES) {
        test(`platform ${p}`, async ({ page }) => {
          await open(page, platformRoute(p), "dark");
          const small = await findSmallTargets(page);
          expect(small.out, "controls without a 44 x 44 hit box").toEqual([]);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, "horizontal page scroll in px").toBeLessThanOrEqual(0);
        });
      }
    }
  });
}
