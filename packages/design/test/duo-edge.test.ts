// The iPhone Duo's strip, edge to edge (mobile layout spec §8, plan Task 9 amended 2026-11-21): the
// grounds run under the strip, the content ends before it. `--cb-inset-right` is the one source.
import { describe, expect, it } from "vitest";
import { css, parseCss } from "./css-rules";

const sheets = ["shell.css", "touch.css", "templates.css", "conversation-page.css"].flatMap((f) =>
  parseCss(css(f)),
);
const rulesFor = (selector: string) =>
  sheets.filter((r) => r.selector.split(",").some((s) => s.trim() === selector));
const INSET = "var(--cb-inset-right)";
const OFFSETS = [
  "margin-right",
  "margin-inline-end",
  "right",
  "inset-inline-end",
  "inset-inline",
  "inset",
];
const PADS = ["padding-right", "padding-inline-end", "padding-inline", "padding"];

const offsetsByInset = (selector: string) =>
  rulesFor(selector).flatMap((r) =>
    OFFSETS.filter((p) => r.decls[p]?.includes(INSET)).map((p) => `${selector} ${p}`),
  );
const padsByInset = (selector: string) =>
  rulesFor(selector).some((r) => PADS.some((p) => r.decls[p]?.includes(INSET)));

describe("Duo edge to edge", () => {
  it("no full-bleed ground is offset by the inset", () => {
    for (const s of [
      ".cb-shell",
      ".cb-body-content",
      ".cb-actionrow",
      ".cb-conv-composer",
      ".cb-drawer-scrim",
      ".cb-shell-column::before",
    ]) {
      expect(offsetsByInset(s), s).toEqual([]);
    }
    expect(rulesFor(".cb-shell").some((r) => r.decls["padding-right"]?.includes(INSET))).toBe(
      false,
    );
  });

  it("the content inside the grounds pads its end by the inset", () => {
    for (const s of [
      ".cb-body-content",
      ".cb-inbox-frame",
      ".cb-actionrow",
      ".cb-conv-composer",
      ".cb-conv-scroll",
      ".cb-conv-pushed-body",
    ]) {
      expect(padsByInset(s), s).toBe(true);
    }
  });

  it("the floating row's trailing control is placed by the inset", () => {
    const placed = (s: string) =>
      rulesFor(s).some((r) =>
        ["right", "inset-inline-end", "inset-inline"].some((p) => r.decls[p]?.includes(INSET)),
      );
    expect(placed(".cb-shell-float")).toBe(true);
    expect(placed(".cb-shell .cb-title-bar")).toBe(true);
  });

  it("the scrim covers the window", () => {
    expect(rulesFor(".cb-drawer-scrim").some((r) => r.decls.inset === "0")).toBe(true);
  });

  it("no rule pads the bottom by a native bar", () => {
    for (const r of sheets.filter((x) => x.selector.includes("[data-native-nav]"))) {
      for (const p of ["padding-bottom", "padding", "margin-bottom"]) {
        expect(r.decls[p], `${r.selector} ${p}`).toBeUndefined();
      }
    }
  });
});
