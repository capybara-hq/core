import { describe, expect, it } from "vitest";
import {
  PLACE_SLOTS,
  resolveUiSlots,
  slotRefOf,
  type UiContribution,
  type UiPlace,
} from "../src/index.js";

const title = { zh: "任务", en: "Tasks" };
const c = (over: Partial<UiContribution> & { id: string }): UiContribution => ({
  title,
  kind: "view",
  ...over,
});

describe("resolveUiSlots", () => {
  it("every place resolves to its slot", () => {
    const table: [UiPlace, string][] = [
      ["panel", "conversation.panel"],
      ["conversation", "conversation.panel"],
      ["section", "conversation.properties.section"],
      ["inline", "conversation.tool-result.card"],
      ["page", "org.page"],
      ["file-preview", "file.preview"],
    ];
    for (const [place, slot] of table) {
      const kind = place === "file-preview" ? "embed" : "view";
      const contribution = c({ id: "a", place, kind });
      expect(slotRefOf(contribution)).toBe(PLACE_SLOTS[place]);
      const r = resolveUiSlots([contribution]);
      expect(r.dropped).toEqual([]);
      expect(r.resolved).toHaveLength(1);
      expect(r.resolved[0]?.slot.id).toBe(slot);
      expect(r.resolved[0]?.version).toBe(1);
      expect(r.resolved[0]?.contribution).toBe(contribution);
    }
  });

  it("an unknown slot is dropped with unknown-slot", () => {
    const r = resolveUiSlots([
      c({ id: "a", slot: "org.page" }),
      c({ id: "b", slot: "nowhere.at-all" }),
    ]);
    expect(r.dropped).toEqual([{ id: "b", ref: "nowhere.at-all", reason: "unknown-slot" }]);
    expect(r.resolved.map((x) => x.contribution.id)).toEqual(["a"]);
  });

  it("conversation.panel@2 is dropped with unsupported-version", () => {
    const r = resolveUiSlots([c({ id: "a", slot: "conversation.panel@2" })]);
    expect(r.dropped).toEqual([
      { id: "a", ref: "conversation.panel@2", reason: "unsupported-version" },
    ]);
    expect(r.resolved).toEqual([]);
  });

  it("an explicit @1 resolves", () => {
    const r = resolveUiSlots([c({ id: "a", slot: "conversation.panel@1" })]);
    expect(r.resolved[0]?.slot.id).toBe("conversation.panel");
    expect(r.resolved[0]?.version).toBe(1);
  });

  it("an alias of a dropped target is dropped with the target's reason", () => {
    const r = resolveUiSlots([
      c({ id: "old", place: "panel", aliasOf: "new" }),
      c({ id: "new", slot: "conversation.panel@2" }),
      c({ id: "old2", slot: "org.page", aliasOf: "gone" }),
      c({ id: "gone", slot: "nowhere.at-all" }),
    ]);
    expect(r.dropped).toEqual([
      { id: "old", ref: "conversation.panel", reason: "unsupported-version" },
      { id: "new", ref: "conversation.panel@2", reason: "unsupported-version" },
      { id: "old2", ref: "org.page", reason: "unknown-slot" },
      { id: "gone", ref: "nowhere.at-all", reason: "unknown-slot" },
    ]);
    expect(r.resolved).toEqual([]);
  });

  it("an alias of a resolved target resolves", () => {
    const r = resolveUiSlots([
      c({ id: "old", place: "conversation", aliasOf: "new" }),
      c({ id: "new", slot: "conversation.panel" }),
    ]);
    expect(r.resolved.map((x) => x.contribution.id)).toEqual(["old", "new"]);
    expect(r.dropped).toEqual([]);
  });

  it("an unknown anchor keeps the default position", () => {
    const r = resolveUiSlots([
      c({ id: "s", slot: "conversation.properties.section", after: "nowhere" }),
    ]);
    expect(r.resolved[0]?.after).toBe("context");
    expect(r.unknownAnchors).toEqual([{ id: "s", after: "nowhere" }]);
  });

  it("a known anchor is kept", () => {
    const r = resolveUiSlots([
      c({ id: "s", slot: "conversation.properties.section", after: "files" }),
    ]);
    expect(r.resolved[0]?.after).toBe("files");
    expect(r.unknownAnchors).toEqual([]);
  });

  it("a section without after gets the first anchor", () => {
    const r = resolveUiSlots([c({ id: "s", place: "section" })]);
    expect(r.resolved[0]?.after).toBe("context");
    expect(r.unknownAnchors).toEqual([]);
  });

  it("an after on a slot without anchors is reported and not kept", () => {
    const r = resolveUiSlots([c({ id: "p", slot: "org.page", after: "context" })]);
    expect(r.resolved[0]).not.toHaveProperty("after");
    expect(r.unknownAnchors).toEqual([{ id: "p", after: "context" }]);
  });

  it("place entries are listed as deprecated", () => {
    const r = resolveUiSlots([
      c({ id: "a", place: "page" }),
      c({ id: "b", slot: "org.page" }),
      c({ id: "c", place: "inline" }),
    ]);
    expect(r.deprecatedPlace).toEqual(["a", "c"]);
  });

  it("keeps manifest order and accepts undefined", () => {
    expect(resolveUiSlots(undefined)).toEqual({
      resolved: [],
      dropped: [],
      unknownAnchors: [],
      deprecatedPlace: [],
    });
    const r = resolveUiSlots([
      c({ id: "z", slot: "org.page" }),
      c({ id: "x", slot: "nowhere.at-all" }),
      c({ id: "a", place: "panel" }),
    ]);
    expect(r.resolved.map((x) => x.contribution.id)).toEqual(["z", "a"]);
  });
});
