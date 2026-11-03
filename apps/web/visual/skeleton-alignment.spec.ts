import { expect, type Page, test } from "@playwright/test";
import { IGNORED_PARTS, LOADING_TEMPLATES, VARIABLE_HEIGHT } from "./accepted";
import { openReference, THEMES } from "./reference-page";

/**
 * Skeleton alignment (web query cache design §7.1): for every template with a loading state, each
 * `data-part` present in both the loading block and the loaded block has the same box, relative
 * to its block: x, y and width within ±1 px, and height too except for the parts in
 * `VARIABLE_HEIGHT`. Layout only; no screenshot comparison.
 */
const ORIGIN = `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`;

type Box = { x: number; y: number; width: number; height: number };

/** Every `[data-part]` box of a block, keyed by `<part>#<n>` (n counts the part's occurrences). */
async function partBoxes(page: Page, block: string): Promise<Record<string, Box>> {
  return page.evaluate((id) => {
    const b = document.querySelector(`[data-ref-block="${id}"]`);
    if (!b) throw new Error(`no block ${id}`);
    const origin = b.getBoundingClientRect();
    const seen: Record<string, number> = {};
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const el of b.querySelectorAll("[data-part]")) {
      const part = el.getAttribute("data-part") ?? "";
      const n = seen[part] ?? 0;
      seen[part] = n + 1;
      const r = el.getBoundingClientRect();
      out[`${part}#${n}`] = {
        x: r.x - origin.x,
        y: r.y - origin.y,
        width: r.width,
        height: r.height,
      };
    }
    return out;
  }, block);
}

for (const theme of THEMES) {
  test.describe(theme, () => {
    for (const t of LOADING_TEMPLATES) {
      test(`template-${t.name}`, async ({ page }) => {
        await openReference(page, `template-${t.name}`, theme, ORIGIN);
        const failures: string[] = [];
        for (const pair of t.pairs) {
          const loaded = await partBoxes(page, `template-${t.name}-${pair.loaded}`);
          const loading = await partBoxes(page, `template-${t.name}-${pair.loading}`);
          const shared = Object.keys(loading).filter(
            (k) => k in loaded && !IGNORED_PARTS.includes(k.split("#")[0] ?? k),
          );
          // A template whose loading block shares no part with the loaded one compares nothing.
          expect(shared.length, `${t.name} ${pair.loading}: no shared data-part`).toBeGreaterThan(
            0,
          );
          for (const k of shared) {
            const a = loaded[k] as Box;
            const b = loading[k] as Box;
            const part = k.split("#")[0] ?? k;
            const variable = VARIABLE_HEIGHT.includes(part);
            const later = variable && !k.endsWith("#0");
            const props: (keyof Box)[] = variable
              ? later
                ? ["x", "width"]
                : ["x", "y", "width"]
              : ["x", "y", "width", "height"];
            for (const p of props) {
              if (Math.abs(a[p] - b[p]) > 1) {
                failures.push(
                  `${t.name} ${pair.loading} ${k} ${p}: loaded ${a[p].toFixed(1)}, loading ${b[p].toFixed(1)}`,
                );
              }
            }
          }
        }
        expect(failures).toEqual([]);
      });
    }
  });
}
