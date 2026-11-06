import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Focus rings show only for keyboard focus (spec §2.5): a ring drawn under `:focus` or
// `:focus-within` also shows after a mouse click (acceptance issue Y: the eval set's 用例 tab).

const STYLES = resolve(__dirname, "../src/styles");

type Rule = { file: string; selector: string; body: string };

/** The innermost `selector { body }` rules of every design stylesheet (comments stripped). */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(resolve(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const selector of (m[1] ?? "").split(",")) {
        out.push({ file, selector: selector.trim(), body: m[2] ?? "" });
      }
    }
  }
  return out;
}

/** A declaration that draws a ring: an outline that is not removed, a box-shadow, a border colour. */
function drawsRing(body: string): boolean {
  if (/(^|;)\s*(box-shadow|border-color)\s*:/.test(body)) return true;
  const outline = body.match(/(?:^|;)\s*outline\s*:\s*([^;]*)/)?.[1]?.trim();
  return outline !== undefined && outline !== "none" && outline !== "0";
}

/**
 * Focus a click also gives: `:focus` / `:focus-within` outside a `:not(...)`, unless the selector
 * also requires `:focus-visible` (`:has(:focus-visible)`).
 */
function mouseFocus(selector: string): boolean {
  const s = selector.replace(/:not\([^)]*\)/g, "");
  return /:focus(-within)?(?![-\w])/.test(s) && !s.includes(":focus-visible");
}

/**
 * Text-entry fields keep their focus on a click by design: a field being typed in shows it, and
 * browsers match `:focus-visible` on a text field after a click anyway.
 */
const TEXT_ENTRY = new Set([
  ".cb-input:focus-within",
  ".cb-textarea:focus-within",
  ".cb-stepper:focus-within",
  ".cb-slider-input:focus",
  ".cb-composer:has(.cb-composer-input:focus)",
]);

describe("focus rings", () => {
  it("no control draws a ring under :focus or :focus-within (text-entry fields aside)", () => {
    const bad = rules()
      .filter((r) => mouseFocus(r.selector) && drawsRing(r.body) && !TEXT_ENTRY.has(r.selector))
      .map((r) => `${r.file}: ${r.selector}`);
    expect(bad).toEqual([]);
  });

  it("the text-entry exceptions still exist (the list only names live rules)", () => {
    const live = new Set(rules().map((r) => r.selector));
    expect([...TEXT_ENTRY].filter((s) => !live.has(s))).toEqual([]);
  });

  it("the tab's ring rule targets :focus-visible, and a tab focused by a pointer draws none", () => {
    const tab = rules().filter((r) => /^\.cb-tab(\[[^\]]+\])*:focus/.test(r.selector));
    expect(tab.length).toBeGreaterThan(0);
    for (const r of tab) expect(r.selector).toMatch(/:focus-visible$/);
    const pointer = tab.find(
      (r) => r.selector === '.cb-tab[data-pointer-focus="true"]:focus-visible',
    );
    expect(pointer?.body).toMatch(/outline\s*:\s*none/);
  });

  it("the Select's halo is keyboard focus or the open list, never a click's focus", () => {
    const select = rules().filter((r) => r.selector.startsWith(".cb-select:focus"));
    expect(select.map((r) => r.selector)).toEqual([".cb-select:focus-visible"]);
  });
});
