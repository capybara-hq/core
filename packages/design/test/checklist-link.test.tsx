import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A checklist item with an open target is a link button (spec §6.16, Checklist), but it reads as
 * the list's text: the global `.cb-link-btn` (muted, always underlined, an inline-flex button that
 * centers wrapped lines) must not leak into the properties panel's task list. conversation.css
 * loads after display.css in the same layer, so the scoped rule must out-rank `.cb-link-btn` and
 * `.cb-link-btn:hover` by specificity. jsdom cannot lay out: the rules are pinned as text and
 * checked in real engines by hand.
 */
const css = readFileSync(resolve(import.meta.dirname, "../src/styles/display.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The declarations of the top-level rules whose selector list holds `sel` exactly. */
function decls(sel: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim().replace(/\s+/g, " "));
    if (selectors.includes(sel)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

describe("a checklist item's link button reads as the item's text", () => {
  const sel = ".cb-tasklist-item > .cb-tasklist-text.cb-link-btn";

  it("starts wrapped lines at the item's start edge, as a block", () => {
    const rule = decls(sel);
    expect(rule).toMatch(/display:\s*block/);
    expect(rule).toMatch(/text-align:\s*start/);
  });

  it("inherits the item's status color and weight, without a permanent underline", () => {
    const rule = decls(sel);
    expect(rule).toMatch(/color:\s*inherit/);
    expect(rule).toMatch(/font-weight:\s*inherit/);
    expect(rule).toMatch(/text-decoration:\s*none/);
  });

  it("underlines on hover and keyboard focus, keeping the item's color", () => {
    const hover = decls(`${sel}:hover`);
    expect(hover).toMatch(/color:\s*inherit/);
    expect(hover).toMatch(/text-decoration-line:\s*underline/);
    expect(decls(`${sel}:focus-visible`)).toMatch(/text-decoration-line:\s*underline/);
  });
});
