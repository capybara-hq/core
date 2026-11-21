import { describe, expect, it } from "vitest";
import { MOBILE_SIZE_QUERY } from "../src/index";
import { css, parseCss } from "./css-rules";

// Rows under the mobile sizes (spec §6.17 ObjectRow, §6.33 ItemList; compact or touch, maintainer
// decision 2026-11-22): 52 high, 56 with a second line, no dividers and no box around the list;
// outside MOBILE_SIZE_QUERY the desktop rules stand.

const touch = parseCss(css("touch.css"));
const templates = parseCss(css("templates.css"));
const under = (rules: ReturnType<typeof parseCss>, at: string | null, selector: string) =>
  rules.find((r) => r.at === at && r.selector === selector)?.decls;

describe("touch rows", () => {
  it("ObjectRow is touch.row high, touch.row.roomy with a second line, with no divider", () => {
    expect(under(touch, MOBILE_SIZE_QUERY, ".cb-object-row")).toMatchObject({
      "min-height": "var(--cb-touch-row)",
      "border-top": "0",
    });
    expect(
      under(touch, MOBILE_SIZE_QUERY, ".cb-object-row:has(.cb-object-desc, .cb-object-meta)"),
    ).toEqual({ "min-height": "var(--cb-touch-row-roomy)" });
  });

  it("the object list loses its card border and ground", () => {
    expect(under(touch, MOBILE_SIZE_QUERY, ".cb-object-list")).toMatchObject({
      border: "0",
      background: "transparent",
    });
  });

  it("ItemList rows follow the same sizes with no divider", () => {
    expect(under(touch, MOBILE_SIZE_QUERY, ".cb-item-list-row")).toMatchObject({
      "min-height": "var(--cb-touch-row)",
      "border-top": "0",
    });
    expect(under(touch, MOBILE_SIZE_QUERY, ".cb-item-list-row:has(.cb-item-list-meta)")).toEqual({
      "min-height": "var(--cb-touch-row-roomy)",
    });
  });

  it("no touch rule leaks out of the touch query for these rows", () => {
    const rows = [".cb-object-row", ".cb-object-list", ".cb-item-list-row"];
    expect(touch.filter((r) => r.at === null && rows.includes(r.selector))).toEqual([]);
  });

  it("the desktop rules are unchanged", () => {
    expect(under(templates, null, ".cb-object-row")).toMatchObject({
      "min-height": "64px",
      "border-top": "1px solid var(--cb-line-soft)",
    });
    expect(under(templates, null, ".cb-object-list")?.border).toBe("1px solid var(--cb-line-card)");
    expect(under(templates, null, ".cb-item-list-row")?.["min-height"]).toBe("var(--cb-row-roomy)");
  });
});
