import { expect, type Page, test } from "@playwright/test";
import { TEMPLATE_ROUTES } from "../src/dev/catalog/routes";

/**
 * The geometric half of the compact rule set (mobile layout spec §11.3): every template's catalog
 * page at the two phone widths (382: the iPhone Duo outer display, 390), with JavaScript on and
 * off (the first paint), on a coarse pointer:
 *
 * - no horizontal page scroll;
 * - every control the design spec guarantees a 40 x 40 hit box has one (the others are counted);
 * - the primary action is reachable (inside the window) after a vertical scroll;
 * - the last item is not under the bottom navigation at the end of a scroll;
 * - text fields are at least 16 px (a smaller one makes iOS zoom the page on focus).
 *
 * The structural half is `findCompactViolations` in packages/design (jsdom). No screenshots: this
 * spec writes no baselines.
 */
const WIDTHS = [382, 390] as const;
const HEIGHT = 844;

/** Interactive elements a hit box applies to. */
const INTERACTIVE =
  "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=switch], [role=checkbox], [role=radio]";

/**
 * Hit boxes the spec does not measure, each with its reason. A link inside running text is exempt
 * (its target is the text); a native control hidden under a larger styled label is measured
 * through its label instead.
 */
const HIT_EXEMPT: { selector: string; why: string }[] = [
  { selector: "p a, li a, dd a, td a", why: "an inline link in running text" },
  { selector: ".cb-skip-link", why: "visually hidden until it has focus" },
  { selector: ".cb-visually-hidden, .cb-sr-only, [data-visually-hidden]", why: "not on screen" },
];

/**
 * The controls design spec §4.3 guarantees a 40 x 40 tap target on a phone (40 high, or an
 * invisible ring around a compact-looking control). These fail the spec when they do not reach it;
 * every other interactive element is only counted (a `hit-census` annotation), because the design
 * spec states no hit area for form fields, selects, steppers, switches, checkboxes and the like.
 */
const GUARANTEED = [
  ".cb-topbar .cb-icon-btn",
  ".cb-bottomnav-item",
  '[data-part="page-header-tabs"] [role="tab"]',
  '[data-part="page-tabs"] [role="tab"]',
  ".cb-pageheader-actions .cb-btn",
  ".cb-object-row .cb-btn",
  ".cb-table-menu .cb-btn",
  '[data-part="title-bar-button"]',
];

/**
 * The 40 x 40 square around a control's center: the edge midpoints, and the corners pulled in by
 * 5 px (a rounded button's corner is not a hit). Rings are drawn from the padding box, so the
 * top bar's ring is `inset: -7px` around a 28 px button with a 1 px border.
 */
const PROBE_EDGE = 19;
const PROBE_CORNER = 15;

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
  for (const width of WIDTHS) {
    test.describe(`compact ${width} ${javaScriptEnabled ? "js on" : "js off"}`, () => {
      test.use({
        viewport: { width, height: HEIGHT },
        isMobile: true,
        hasTouch: true,
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

          // every guaranteed control has a 40 x 40 hit box. A small control reaches it through an
          // invisible ring (spec §4.3), which getBoundingClientRect does not see, so the box is
          // probed: the edges and corners of the 40 x 40 square around the element's center must hit
          // the element (or something inside it, or the label of a native control).
          const small = await page.evaluate(
            ({ interactive, exempt, guaranteed, edge, corner }) => {
              const out: string[] = [];
              const census: string[] = [];
              const hits = (el: Element, x: number, y: number) => {
                const at = document.elementFromPoint(x, y);
                if (!at) return false;
                if (el.contains(at)) return true;
                const label = at.closest("label");
                return (
                  el instanceof HTMLInputElement &&
                  !!el.labels &&
                  Array.from(el.labels).includes(label as HTMLLabelElement)
                );
              };
              for (const el of Array.from(document.querySelectorAll(interactive))) {
                if (exempt.some((s) => el.matches(s))) continue;
                if (el.closest("[hidden], [aria-hidden='true'], [inert]")) continue;
                const cs = getComputedStyle(el);
                if (cs.display === "none" || cs.visibility === "hidden") continue;
                if (el.getBoundingClientRect().width === 0) continue;
                el.scrollIntoView({ block: "center", inline: "center" });
                const r = el.getBoundingClientRect();
                const cx = r.left + r.width / 2;
                const cy = r.top + r.height / 2;
                const corners = [
                  [cx - edge, cy],
                  [cx + edge, cy],
                  [cx, cy - edge],
                  [cx, cy + edge],
                  [cx - corner, cy - corner],
                  [cx + corner, cy - corner],
                  [cx - corner, cy + corner],
                  [cx + corner, cy + corner],
                ] as const;
                if (!corners.every(([x, y]) => hits(el, x, y))) {
                  const text = (el.getAttribute("aria-label") ?? el.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 30);
                  (el.matches(guaranteed) ? out : census).push(
                    `<${el.tagName.toLowerCase()} ${el.getAttribute("data-part") ?? el.className}> ${text} ${Math.round(r.width)}x${Math.round(r.height)}`,
                  );
                }
              }
              window.scrollTo(0, 0);
              return { out, census };
            },
            {
              interactive: INTERACTIVE,
              exempt: HIT_EXEMPT.map((e) => e.selector),
              guaranteed: GUARANTEED.join(", "),
              edge: PROBE_EDGE,
              corner: PROBE_CORNER,
            },
          );
          if (small.census.length > 0) {
            test.info().annotations.push({
              type: "hit-census",
              description: `${small.census.length} controls without a stated tap target: ${small.census.join("; ")}`,
            });
          }
          expect(small.out, "interactive elements without a 40 x 40 hit box").toEqual([]);

          // text fields are at least 16 px on a coarse pointer
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

          // the last item is not under the bottom navigation
          const covered = await page.evaluate(() => {
            const nav = document.querySelector('[data-part="bottom-nav"]');
            const main = document.querySelector(".cb-shell-main") ?? document.body;
            if (!nav) return null;
            const navTop = nav.getBoundingClientRect().top;
            let last: Element = main;
            for (;;) {
              const kids = Array.from(last.children).filter((c) => {
                const r = c.getBoundingClientRect();
                return r.height > 0 && getComputedStyle(c).position !== "fixed";
              });
              const next = kids[kids.length - 1];
              if (!next) break;
              last = next;
            }
            const bottom = last.getBoundingClientRect().bottom;
            return bottom <= navTop + 1 ? null : { bottom, navTop };
          });
          expect(covered, "the last item under the bottom navigation").toBeNull();
        });
      }
    });
  }
}
