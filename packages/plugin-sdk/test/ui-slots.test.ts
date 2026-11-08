import { describe, expect, it } from "vitest";
import {
  PLACE_SLOTS,
  parseSlotRef,
  UI_ARRANGEABLE_SLOTS,
  UI_SLOT_IDS,
  UI_SLOTS,
  uiContributionKey,
  uiSlot,
} from "../src/index.js";

describe("ui slot catalog", () => {
  it("slot ids are unique and every version is a positive integer", () => {
    const ids = UI_SLOTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...UI_SLOT_IDS]).toEqual(ids);
    for (const s of UI_SLOTS) {
      expect(Number.isInteger(s.version) && s.version > 0).toBe(true);
    }
  });

  it("platform scope goes with superAdmin and nothing else does", () => {
    for (const s of UI_SLOTS) {
      expect(s.scope === "platform").toBe(s.minRole === "superAdmin");
    }
  });

  it("anchors are unique within a slot and only the properties section has them", () => {
    for (const s of UI_SLOTS) {
      const anchors = s.anchors ?? [];
      expect(new Set(anchors).size).toBe(anchors.length);
      if (s.id !== "conversation.properties.section") expect(anchors).toEqual([]);
    }
    expect(uiSlot("conversation.properties.section")?.anchors).toEqual([
      "context",
      "files",
      "background",
    ]);
  });

  it("owners are apps/web/src paths ending in .tsx", () => {
    for (const s of UI_SLOTS) {
      expect(s.owner.startsWith("/")).toBe(false);
      expect(s.owner.includes("..")).toBe(false);
      expect(s.owner.endsWith(".tsx")).toBe(true);
    }
  });

  it("zh descriptions avoid 企业 and the Latin word agent", () => {
    for (const s of UI_SLOTS) {
      expect(s.description.zh).not.toMatch(/企业|agent/i);
      expect(s.description.en.length).toBeGreaterThan(0);
    }
  });

  it("parseSlotRef reads an id with and without a version", () => {
    expect(parseSlotRef("org.page")).toEqual({ id: "org.page", version: 1 });
    expect(parseSlotRef("org.page@2")).toEqual({ id: "org.page", version: 2 });
    for (const bad of ["org.page@0", "org", "Org.page", "org.page@"]) {
      expect(parseSlotRef(bad)).toBeNull();
    }
  });

  it("every place maps to a catalog slot", () => {
    for (const k of Object.keys(PLACE_SLOTS)) {
      expect(uiSlot(PLACE_SLOTS[k as keyof typeof PLACE_SLOTS])).toBeDefined();
    }
  });

  it("file.preview is not arrangeable", () => {
    expect(UI_ARRANGEABLE_SLOTS).not.toContain("file.preview");
    expect(UI_ARRANGEABLE_SLOTS).toHaveLength(UI_SLOTS.length - 1);
  });

  it("builds contribution keys", () => {
    expect(uiContributionKey("todo", "board")).toBe("todo/board");
  });
});
