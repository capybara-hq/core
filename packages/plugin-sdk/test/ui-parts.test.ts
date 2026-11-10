import { describe, expect, it } from "vitest";
import { UI_PART_NAMES, UI_PARTS, uiPart } from "../src/index.js";

describe("ui part catalog", () => {
  it("part names are unique and dotted lower-case", () => {
    const names = UI_PARTS.map((p) => p.name);
    expect(UI_PARTS).toHaveLength(29);
    expect(new Set(names).size).toBe(names.length);
    expect([...UI_PART_NAMES]).toEqual(names);
    for (const n of names) expect(n).toMatch(/^[a-z]+(-[a-z]+)*(\.[a-z]+(-[a-z]+)*)*$/);
    for (const p of UI_PARTS) expect(p.version).toBe(1);
    expect(uiPart("button.primary")?.states).toEqual(["disabled"]);
    expect(uiPart("nope")).toBeUndefined();
    // the theme plugin round: the states themes target on the new parts
    expect(uiPart("switch")?.states).toEqual(["aria-checked", "disabled"]);
    expect(uiPart("agent-chip")?.states).toEqual(["aria-pressed"]);
    expect(uiPart("message.assistant")?.states).toEqual(["aria-busy"]);
  });

  it("owners are under packages/design/src or apps/web/src", () => {
    for (const p of UI_PARTS) {
      expect(p.owner.length).toBeGreaterThan(0);
      for (const o of p.owner) {
        expect(o).toMatch(/^(packages\/design\/src|apps\/web\/src)\/.+\.tsx$/);
      }
    }
  });

  it("zh descriptions avoid 企业", () => {
    for (const p of UI_PARTS) {
      expect(p.description.zh).not.toContain("企业");
      expect(p.description.zh).not.toMatch(/agent/i);
      expect(p.description.en.length).toBeGreaterThan(0);
    }
  });
});
