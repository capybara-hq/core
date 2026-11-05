import { describe, expect, it } from "vitest";
import { EXTENSION_POINTS } from "../src/index.js";

describe("EXTENSION_POINTS selection", () => {
  it("only web-search and web-fetch carry org-default selection", () => {
    const want = {
      cardinality: "multi",
      brokered: true,
      orgScoped: true,
      selection: "org-default",
    };
    expect(EXTENSION_POINTS["web-search"]).toEqual(want);
    expect(EXTENSION_POINTS["web-fetch"]).toEqual(want);
    const withSelection = Object.entries(EXTENSION_POINTS)
      .filter(([, v]) => v.selection !== undefined)
      .map(([k]) => k);
    expect(withSelection.sort()).toEqual(["web-fetch", "web-search"]);
  });
});
