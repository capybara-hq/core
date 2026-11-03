import { expect, type Page, test } from "@playwright/test";
import {
  DATA_ONLY_PARTS,
  IGNORED_PARTS,
  LOADING_TEMPLATES,
  VARIABLE_HEIGHT,
  VARIABLE_WIDTH,
} from "./accepted";
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
          const where = `${t.name} ${pair.loading}`;
          const loaded = await partBoxes(page, `template-${t.name}-${pair.loaded}`);
          const loading = await partBoxes(page, `template-${t.name}-${pair.loading}`);
          const nameOf = (k: string) => k.split("#")[0] ?? k;
          const count = (boxes: Record<string, Box>, part: string) =>
            Object.keys(boxes).filter((k) => nameOf(k) === part).length;
          const loadedParts = [...new Set(Object.keys(loaded).map(nameOf))].filter(
            (p) => !IGNORED_PARTS.includes(p),
          );
          // Every loaded part, by name and count, is drawn while loading (unless it is data only).
          for (const part of loadedParts) {
            if (part in DATA_ONLY_PARTS) continue;
            const want = count(loaded, part);
            const got = count(loading, part);
            if (want !== got) {
              failures.push(`${where}: ${part} appears ${got}x while loading, ${want}x loaded`);
            }
          }
          // Parts of equal count pair by name and index.
          const paired = Object.keys(loaded).filter(
            (k) =>
              k in loading &&
              !IGNORED_PARTS.includes(nameOf(k)) &&
              count(loaded, nameOf(k)) === count(loading, nameOf(k)),
          );
          expect(paired.length, `${where}: no part pairs`).toBeGreaterThan(0);
          // The exempt parts above a part move it by their height difference: it is corrected for.
          const exempt = paired.filter((k) => nameOf(k) in VARIABLE_HEIGHT);
          const shift = (k: string) => {
            const a = loaded[k] as Box;
            const above = exempt.filter((e) => {
              const b = loaded[e] as Box;
              return e !== k && b.y + b.height <= a.y + 1;
            });
            const outer = above.filter((e) => {
              const b = loaded[e] as Box;
              return !above.some((o) => {
                const c = loaded[o] as Box;
                return (
                  o !== e &&
                  c.x <= b.x + 1 &&
                  c.y <= b.y + 1 &&
                  c.y + c.height >= b.y + b.height - 1 &&
                  (c.height > b.height + 1 || o < e)
                );
              });
            });
            return outer.reduce(
              (sum, e) => sum + (loading[e] as Box).height - (loaded[e] as Box).height,
              0,
            );
          };
          for (const k of paired) {
            const a = loaded[k] as Box;
            const b = loading[k] as Box;
            const part = nameOf(k);
            const props = (["x", "y", "width", "height"] as const).filter(
              (p) =>
                !(p === "height" && part in VARIABLE_HEIGHT) &&
                !(p === "width" && part in VARIABLE_WIDTH),
            );
            for (const p of props) {
              const want = p === "y" ? a.y + shift(k) : a[p];
              if (Math.abs(want - b[p]) > 1) {
                failures.push(
                  `${where} ${k} ${p}: loaded ${want.toFixed(1)}, loading ${b[p].toFixed(1)}`,
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
