import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MOBILE_SIZE_QUERY } from "../src/index";
import { css, parseCss } from "./css-rules";

// The mobile sizes of the controls (spec §2.5, maintainer decision 2026-11-22): under
// MOBILE_SIZE_QUERY (compact whatever the pointer, or touch) the controls take the mobile control
// scale and a control with text pads wider than it is tall. The geometry is measured in the
// browser (apps/web/visual/compact.interaction.spec.ts); these pin the rules and their one query.

const under = (file: string, selector: string) =>
  parseCss(css(file)).find((r) => r.at === MOBILE_SIZE_QUERY && r.selector === selector)?.decls;

describe("mobile size rules", () => {
  it("buttons and chips pad space.4 at the sides (space.5 at prominent); icon buttons are spared", () => {
    expect(
      under(
        "controls.css",
        '.cb-btn:not(.cb-icon-btn), .cb-btn[data-density="dense"]:not(.cb-icon-btn), .cb-chip, .cb-chip[data-density="dense"]',
      ),
    ).toEqual({ "padding-inline": "var(--cb-space-4)" });
    expect(under("controls.css", '.cb-btn[data-density="prominent"]:not(.cb-icon-btn)')).toEqual({
      "padding-inline": "var(--cb-space-5)",
    });
  });

  it("text fields pad their text space.3 from the border", () => {
    expect(
      under(
        "controls.css",
        ".cb-input input, .cb-textarea textarea, .cb-stepper input, .cb-input-affix:first-child + input",
      ),
    ).toEqual({ "padding-inline": "var(--cb-space-3)" });
    expect(under("controls.css", ".cb-select-value")).toEqual({
      "padding-left": "var(--cb-space-3)",
    });
  });

  it("tabs are touch.hit high padded space.4; a segmented group is control.prominent high", () => {
    expect(under("display.css", ".cb-tab")).toEqual({
      height: "var(--cb-touch-hit)",
      padding: "0 var(--cb-space-4)",
    });
    expect(
      under(
        "display.css",
        '.cb-segmented, .cb-segmented[data-density="dense"], .cb-segmented[data-density="prominent"]',
      ),
    ).toEqual({ height: "var(--cb-control-prominent)" });
    expect(under("display.css", ".cb-seg")).toEqual({
      "min-width": "var(--cb-touch-hit)",
      padding: "0 var(--cb-space-4)",
    });
  });

  it("text fields are at least 16 px under the mobile sizes", () => {
    const rules = parseCss(css("base.css")).filter((r) => r.at === MOBILE_SIZE_QUERY);
    expect(rules.some((r) => r.decls["font-size"] === "max(16px, 1em) !important")).toBe(true);
  });

  it("every stylesheet spells a compact-or-touch query as MOBILE_SIZE_QUERY exactly", () => {
    const dir = resolve(import.meta.dirname, "../src/styles");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".css"))) {
      for (const r of parseCss(css(file))) {
        if (r.at?.includes("599px") && r.at.includes("coarse")) {
          expect(r.at, `${file} ${r.selector}`).toBe(MOBILE_SIZE_QUERY);
        }
      }
    }
  });
});
