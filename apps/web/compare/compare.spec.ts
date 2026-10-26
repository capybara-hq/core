import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { blockIds, openReference, THEMES } from "../visual/reference-page";

/**
 * Writes apps/web/compare-out/ (or COMPARE_OUT): `<id>-<theme>.impl.png` (the `/dev/ui` block),
 * `<id>-<theme>.ref.png` (copied from docs/design/reference) and index.html, one row per block.
 * COMPARE (comma-separated components) is required; a missing reference PNG fails.
 */
const ORIGIN = `http://localhost:${process.env.CAPYBARA_VISUAL_PORT ?? "3100"}`;
const refDir = resolve(import.meta.dirname, "../../../docs/design/reference");
// COMPARE_OUT (relative to apps/web) writes elsewhere, so two reviews don't share one folder.
const outDir = resolve(import.meta.dirname, "..", process.env.COMPARE_OUT ?? "compare-out");
const components = (process.env.COMPARE ?? "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

test("side by side", async ({ page }) => {
  expect(components, "set COMPARE=<component>[,<component>…]").not.toEqual([]);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const rows: { id: string; theme: string }[] = [];
  const missing: string[] = [];
  for (const component of components) {
    for (const theme of THEMES) {
      await openReference(page, component, theme, ORIGIN);
      const ids = await blockIds(page);
      expect(ids, `${component} has no blocks in /dev/ui/reference`).not.toEqual([]);
      for (const id of ids) {
        const ref = resolve(refDir, `${id}-${theme}.png`);
        if (!existsSync(ref)) {
          missing.push(`${id}-${theme}.png`);
          continue;
        }
        copyFileSync(ref, resolve(outDir, `${id}-${theme}.ref.png`));
        await page
          .locator(`[data-ref-block="${id}"]`)
          .screenshot({ path: resolve(outDir, `${id}-${theme}.impl.png`), animations: "disabled" });
        rows.push({ id, theme });
      }
    }
  }
  const body = rows
    .map(
      (r) => `<figure><figcaption>${esc(r.id)} · ${r.theme}</figcaption><div class="pair">
<img src="${esc(r.id)}-${r.theme}.ref.png" alt="reference ${esc(r.id)} ${r.theme}">
<img src="${esc(r.id)}-${r.theme}.impl.png" alt="implementation ${esc(r.id)} ${r.theme}">
</div></figure>`,
    )
    .join("\n");
  writeFileSync(
    resolve(outDir, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reference | implementation</title>
<style>body{margin:24px;background:#808080;font:13px monospace}figure{margin:0 0 32px}
figcaption{margin-bottom:8px}.pair{display:flex;gap:24px;align-items:flex-start}
.pair img{zoom:.5;outline:1px dashed #fff}</style></head><body>
<h1>Reference (left) | implementation (right): ${esc(components.join(", "))}</h1>
${body}
</body></html>
`,
  );
  expect(
    missing,
    "reference PNGs missing: run pnpm --filter @capybara-hq/web reference:render",
  ).toEqual([]);
});
