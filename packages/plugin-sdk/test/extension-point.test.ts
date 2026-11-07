import { describe, expect, it } from "vitest";
import { EXTENSION_POINTS } from "../src/index.js";

describe("EXTENSION_POINTS selection", () => {
  it("only web-search and web-fetch carry org-default selection", () => {
    const want = {
      majors: [1],
      cardinality: "multi",
      brokered: true,
      orgScoped: true,
      selection: "org-default",
    };
    expect(EXTENSION_POINTS["web-search"]).toMatchObject(want);
    expect(EXTENSION_POINTS["web-fetch"]).toMatchObject(want);
    for (const k of ["web-search", "web-fetch"] as const) {
      expect(EXTENSION_POINTS[k]?.description).toMatch(/\S/);
    }
    const withSelection = Object.entries(EXTENSION_POINTS)
      .filter(([, v]) => v.selection !== undefined)
      .map(([k]) => k);
    expect(withSelection.sort()).toEqual(["web-fetch", "web-search"]);
  });
});

describe("EXTENSION_POINTS majors", () => {
  it("every extension point lists its supported majors", () => {
    for (const [name, info] of Object.entries(EXTENSION_POINTS)) {
      expect(info.majors.length, name).toBeGreaterThan(0);
    }
    expect(EXTENSION_POINTS.sandbox?.majors).toEqual([2]);
    expect(EXTENSION_POINTS["model-provider"]?.majors).toEqual([1, 2]);
    expect(EXTENSION_POINTS.channel?.majors).toEqual([1]);
  });
});
