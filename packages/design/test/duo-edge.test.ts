// The iPhone Duo's strip, edge to edge (mobile layout spec §8, plan Task 9 amended 2026-11-21): the
// grounds run under the strip, the content ends before it. `--cb-inset-right` is the one source.
// The strip is physical (it sits on the right whatever the writing direction), so the rules use
// `padding-right` / `right`, never the logical forms.
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type CssRule, css, parseCss } from "./css-rules";

const files = readdirSync(resolve(import.meta.dirname, "../src/styles")).filter((f) =>
  f.endsWith(".css"),
);
const sheets: CssRule[] = files.flatMap((f) => parseCss(css(f)));
const INSET = "var(--cb-inset-right)";
const rulesFor = (selector: string) =>
  sheets.filter((r) => r.selector.split(",").some((s) => s.trim() === selector));

/** Properties that offset a box from the right edge. */
const OFFSETS = ["margin-right", "margin-inline-end", "right", "inset-inline-end", "inset-inline"];
const PADDING = ["padding", "padding-inline", "padding-right"];

/** The value that wins in a rule: the later of `padding` and `padding-right` in source order. */
const winningPad = (r: CssRule) => {
  const keys = Object.keys(r.decls).filter((k) => PADDING.includes(k));
  const k = keys.at(-1);
  return k === undefined ? undefined : { prop: k, value: r.decls[k] ?? "" };
};
/** Per at-rule condition, the last rule that sets a right padding wins. */
const winningPads = (selector: string) => {
  const byAt = new Map<string | null, { prop: string; value: string }>();
  for (const r of rulesFor(selector)) {
    const w = winningPad(r);
    if (w) byAt.set(r.at, w);
  }
  return byAt;
};
const padsEnd = (selector: string) => {
  const w = winningPads(selector);
  return w.size > 0 && [...w.values()].every((x) => x.value.includes(INSET));
};
const placedByInset = (selector: string, prop: "right") => {
  const byAt = new Map<string | null, string>();
  for (const r of rulesFor(selector)) if (r.decls[prop]) byAt.set(r.at, r.decls[prop] ?? "");
  return byAt.size > 0 && [...byAt.values()].every((v) => v.includes(INSET));
};

describe("Duo edge to edge", () => {
  it("no full-bleed ground is offset by the inset", () => {
    for (const s of [
      ".cb-shell",
      ".cb-body-content",
      ".cb-actionrow",
      ".cb-conv-composer",
      ".cb-drawer-scrim",
      ".cb-shell-column::before",
      ".cb-sheet",
    ]) {
      for (const r of rulesFor(s)) {
        for (const p of OFFSETS) expect(r.decls[p] ?? "", `${s} ${p}`).not.toContain(INSET);
      }
    }
    for (const r of rulesFor(".cb-shell")) {
      expect(r.decls["padding-right"] ?? "").not.toContain(INSET);
    }
    expect(rulesFor(".cb-sheet").some((r) => r.decls.right === "0")).toBe(true);
  });

  it("the content inside the grounds pads its end by the inset (the winning declaration)", () => {
    for (const s of [
      ".cb-body-content",
      ".cb-inbox-frame",
      ".cb-actionrow",
      ".cb-conv-composer",
      ".cb-conv-scroll",
      ".cb-conv-pushed-body",
      ".cb-conv-pushed-bar",
      ".cb-title-bar",
      ".cb-rpanel",
      ".cb-template-head",
      ".cb-sheet",
      '.cb-shell[data-banner="true"] > .cb-shell-banner',
    ]) {
      expect(padsEnd(s), s).toBe(true);
    }
  });

  it("controls placed from the right edge add the inset", () => {
    for (const s of [".cb-shell-float", ".cb-shell .cb-title-bar", ".cb-conv-latest"]) {
      expect(placedByInset(s, "right"), s).toBe(true);
    }
  });

  it("no rule uses a logical end offset with the inset (the strip is physical)", () => {
    for (const r of sheets) {
      for (const [p, v] of Object.entries(r.decls)) {
        if (!v.includes(INSET)) continue;
        expect(
          ["padding-inline-end", "padding-inline", "inset-inline-end", "inset-inline"],
          `${r.selector} ${p}`,
        ).not.toContain(p);
      }
    }
  });

  it("the scrim covers the window", () => {
    expect(rulesFor(".cb-drawer-scrim").some((r) => r.decls.inset === "0")).toBe(true);
  });

  it("no rule pads the bottom by a native bar", () => {
    // a rule for the strip: `[data-native-nav]` outside `:not(...)` (a `:not` one is the browser's)
    const forStrip = (selector: string) =>
      selector.replace(/:not\([^()]*\)/g, "").includes("[data-native-nav");
    for (const r of sheets.filter((x) => forStrip(x.selector))) {
      for (const p of ["padding-bottom", "padding", "margin-bottom"]) {
        expect(r.decls[p], `${r.selector} ${p}`).toBeUndefined();
      }
    }
  });
});
