import { expect, type Page, test } from "@playwright/test";
import {
  DATA_ONLY_PARTS,
  IGNORED_PARTS,
  LOADING_ALIASES,
  LOADING_TEMPLATES,
  RIGHT_ALIGNED,
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

/** `scroller` numbers the nearest ancestor that clips or scrolls vertically (0: none). */
type Box = { x: number; y: number; width: number; height: number; scroller: number };

/** Every `[data-part]` box of a block, keyed by `<part>#<n>` (n counts the part's occurrences). */
async function partBoxes(page: Page, block: string): Promise<Record<string, Box>> {
  return page.evaluate(
    ([id, aliases]) => {
      const b = document.querySelector(`[data-ref-block="${id}"]`);
      if (!b) throw new Error(`no block ${id}`);
      const origin = b.getBoundingClientRect();
      const seen: Record<string, number> = {};
      const out: Record<
        string,
        { x: number; y: number; width: number; height: number; scroller: number }
      > = {};
      const scrollers: Element[] = [];
      const scrollerOf = (el: Element) => {
        for (let p = el.parentElement; p && p !== b; p = p.parentElement) {
          if (getComputedStyle(p).overflowY !== "visible") {
            if (!scrollers.includes(p)) scrollers.push(p);
            return scrollers.indexOf(p) + 1;
          }
        }
        return 0;
      };
      for (const el of b.querySelectorAll("[data-part]")) {
        const raw = el.getAttribute("data-part") ?? "";
        const part = aliases[raw] ?? raw;
        const n = seen[part] ?? 0;
        seen[part] = n + 1;
        const r = el.getBoundingClientRect();
        out[`${part}#${n}`] = {
          x: r.x - origin.x,
          y: r.y - origin.y,
          width: r.width,
          height: r.height,
          scroller: scrollerOf(el),
        };
      }
      return out;
    },
    [block, LOADING_ALIASES] as const,
  );
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
            if (part in DATA_ONLY_PARTS || part in (pair.dataOnly ?? {})) continue;
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
          // The exempt parts above a part, in the same scrolling region, move it by their height
          // difference: it is corrected for. Parts outside (the action row, the status bar, the
          // composer) are anchored to the window and compared as they are.
          const exempt = paired.filter((k) => nameOf(k) in VARIABLE_HEIGHT);
          const shift = (k: string) => {
            const a = loaded[k] as Box;
            const above = exempt.filter((e) => {
              const b = loaded[e] as Box;
              const overlapsX = b.x < a.x + a.width && a.x < b.x + b.width;
              return e !== k && b.scroller === a.scroller && overlapsX && b.y + b.height <= a.y + 1;
            });
            // Count each region once: a box inside (or equal to) one already counted is skipped.
            const taken: string[] = [];
            for (const e of [...above].sort(
              (x, y) => (loaded[y] as Box).height - (loaded[x] as Box).height,
            )) {
              const b = loaded[e] as Box;
              const inside = taken.some((o) => {
                const c = loaded[o] as Box;
                return (
                  c.x <= b.x + 1 &&
                  c.y <= b.y + 1 &&
                  c.x + c.width >= b.x + b.width - 1 &&
                  c.y + c.height >= b.y + b.height - 1
                );
              });
              if (!inside) taken.push(e);
            }
            return taken.reduce(
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
              const right = p === "x" && RIGHT_ALIGNED.includes(part);
              const want = p === "y" ? a.y + shift(k) : right ? a.x + a.width : a[p];
              const got = right ? b.x + b.width : b[p];
              if (Math.abs(want - got) > 1) {
                failures.push(
                  `${where} ${k} ${right ? "right edge" : p}: loaded ${want.toFixed(1)}, loading ${got.toFixed(1)}`,
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
