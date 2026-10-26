import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
// Playwright loads TS without the @capybara-hq/source condition, so the pure parser is imported by
// path (as reference/render.spec.ts does with the fixtures).
import {
  missingStates,
  parseSizeTables,
  parseStateLists,
  partSelector,
  resolveToken,
} from "../../../packages/design/src/reference/index";
import { ACCEPTED } from "./accepted";
import { blockIds, openReference, THEMES } from "./reference-page";

/**
 * Measuring and state coverage (design spec §9.3, §9.4): every accepted component's
 * `/dev/ui/reference/<component>` blocks against the spec's size tables, in both themes. Sizes
 * within ±1px; colors equal to the token, compared as the browser computes both.
 */
const ORIGIN = `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`;
const root = resolve(import.meta.dirname, "../../..");
const spec = readFileSync(resolve(root, "docs/design/spec.md"), "utf8");
const tokens = JSON.parse(
  readFileSync(resolve(root, "docs/design/tokens.json"), "utf8"),
) as unknown;
const tables = parseSizeTables(spec);
const lists = parseStateLists(spec);

const COLOR_PROPS = /(^|-)color$/;

test("the reference route answers", async ({ page }) => {
  const res = await openReference(page, "page-header", "dark", ORIGIN);
  expect(res.status()).toBe(200);
});

for (const theme of THEMES) {
  test.describe(theme, () => {
    for (const component of ACCEPTED) {
      test(component, async ({ page }) => {
        await openReference(page, component, theme, ORIGIN);
        expect(missingStates(lists, await blockIds(page), [component])).toEqual([]);
        const rows = tables.find((t) => t.component === component)?.rows ?? [];
        // An accepted component without a size table would measure nothing and pass silently.
        expect(
          rows.length,
          `${component} has no size table in docs/design/spec.md`,
        ).toBeGreaterThan(0);
        const failures: string[] = [];
        for (const r of rows) {
          const expected = resolveToken(tokens, r.value, theme);
          const got = await page.evaluate(
            ({ block, selector, property, expected, isColor }) => {
              const b = document.querySelector(`[data-ref-block="${block}"]`);
              if (!b) return { error: `no block ${block}` };
              const el = selector === ":scope" ? b : b.querySelector(selector);
              if (!el) return { error: `no element ${selector}` };
              const cs = getComputedStyle(el);
              if (isColor) {
                const probe = document.createElement("span");
                probe.style.color = String(expected);
                b.append(probe);
                const want = getComputedStyle(probe).color;
                probe.remove();
                return { actual: cs.getPropertyValue(property), want };
              }
              if (property === "width" || property === "height") {
                const box = el.getBoundingClientRect();
                return { actual: String(property === "width" ? box.width : box.height) };
              }
              return { actual: cs.getPropertyValue(property) };
            },
            {
              block: `${component}-${r.state}`,
              selector: partSelector(r.part),
              property: r.property,
              expected,
              isColor: COLOR_PROPS.test(r.property),
            },
          );
          const where = `${component}-${r.state} ${r.part} ${r.property} (spec.md:${r.line})`;
          if ("error" in got) {
            failures.push(`${where}: ${got.error}`);
          } else if (COLOR_PROPS.test(r.property)) {
            if (got.actual !== got.want) {
              failures.push(`${where}: expected ${r.value} = ${got.want}, got ${got.actual}`);
            }
          } else {
            const actual = Number.parseFloat(got.actual ?? "");
            if (!(Math.abs(actual - Number(expected)) <= 1)) {
              failures.push(`${where}: expected ${r.value} = ${expected}px, got ${got.actual}`);
            }
          }
        }
        expect(failures).toEqual([]);
      });
    }
  });
}

// The input focus halo (design spec §2.5, §6.2): `box-shadow: 0 0 0 3px focus-ring`. A size table
// row holds one length or color, so the compound shadow is compared here, as the browser
// computes both.
for (const theme of THEMES) {
  test(`input focus halo (${theme})`, async ({ page }) => {
    await openReference(page, "input", theme, ORIGIN);
    const ring = resolveToken(tokens, "color.focus-ring", theme);
    const got = await page.evaluate((ring) => {
      const block = document.querySelector('[data-ref-block="input-focus"]');
      const el = block?.querySelector('[data-part="input"]');
      if (!block || !el) return { error: "no input-focus block or input part" };
      const probe = document.createElement("span");
      probe.style.boxShadow = `0 0 0 3px ${ring}`;
      block.append(probe);
      const want = getComputedStyle(probe).boxShadow;
      probe.remove();
      return { actual: getComputedStyle(el).boxShadow, want };
    }, String(ring));
    expect("error" in got ? got.error : got.actual).toBe("want" in got ? got.want : "");
  });
}
