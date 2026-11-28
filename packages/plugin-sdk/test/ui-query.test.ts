import { describe, expect, it } from "vitest";
import { UI_LIMITS, validateUiContributions } from "../src/index.js";

const perms = { client: true, ui: { components: ["p"] } };
const ui = (extra: Record<string, unknown>, slot = "org.page") => [
  { id: "p", title: { zh: "页", en: "Page" }, slot, kind: "component", ...extra },
];

describe("full page limits and manifest fields", () => {
  it("declares the query and page limits", () => {
    expect(UI_LIMITS.componentQueryBytes).toBe(1048576);
    expect(UI_LIMITS.componentQueryParamsBytes).toBe(16384);
    expect(UI_LIMITS.componentActionPayloadBytes).toBe(65536);
    expect(UI_LIMITS.pageParamsBytes).toBe(2048);
    expect(UI_LIMITS.payloadBytes).toBe(2000);
  });

  it("accepts frame and nav on an org.page component", () => {
    expect(validateUiContributions(ui({ frame: "page", nav: "more" }), perms)).toEqual([]);
  });

  it("refuses frame on a slot other than org.page", () => {
    const errs = validateUiContributions(ui({ frame: "page" }, "conversation.panel"), perms);
    expect(errs.join("\n")).toMatch(/frame is only allowed on a component of the org.page slot/);
  });

  it("refuses nav on a view and values outside the lists", () => {
    const view = [{ ...ui({ nav: "primary" })[0], kind: "view" }];
    const errs = validateUiContributions(view, { ui: { views: ["p"] } });
    expect(errs.join("\n")).toMatch(/nav is only allowed/);
    expect(validateUiContributions(ui({ frame: "full" }), perms).join("\n")).toMatch(
      /frame must be one of host, page/,
    );
  });
});
