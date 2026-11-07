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

/**
 * A declaration that draws a ring: a box-shadow, an outline (shorthand or `outline-color` /
 * `-width` / `-style`) that is not removed, or a border (shorthand, a side, its colour or width)
 * that is not removed.
 */
function drawsRing(body: string): boolean {
  for (const decl of body.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    const removed = value === "none" || value === "0" || value === "0px";
    if (prop === "box-shadow" && !removed) return true;
    if (/^outline(-(color|width|style))?$/.test(prop) && !removed) return true;
    if (
      /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-(color|width))?$/.test(
        prop,
      ) &&
      !removed
    )
      return true;
  }
  return false;
}

describe("drawsRing", () => {
  it("catches outline longhands and the border shorthand, not their removal", () => {
    expect(drawsRing("outline-color: var(--cb-accent)")).toBe(true);
    expect(drawsRing("outline-width: 2px")).toBe(true);
    expect(drawsRing("outline-style: solid")).toBe(true);
    expect(drawsRing("border: 1px solid var(--cb-accent)")).toBe(true);
    expect(drawsRing("border-bottom-color: red")).toBe(true);
    expect(drawsRing("border-color: red")).toBe(true);
    expect(drawsRing("box-shadow: 0 0 0 3px red")).toBe(true);
    expect(drawsRing("outline: none")).toBe(false);
    expect(drawsRing("outline: 0")).toBe(false);
    expect(drawsRing("border: none")).toBe(false);
    expect(drawsRing("color: red; opacity: 1")).toBe(false);
  });
});

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
