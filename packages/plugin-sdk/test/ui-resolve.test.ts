import { describe, expect, it } from "vitest";
import { resolveUiSlots, type UiContribution } from "../src/index.js";

const title = { zh: "任务", en: "Tasks" };
const c = (over: Partial<UiContribution> & { id: string; slot: string }): UiContribution => ({
  title,
  kind: "view",
  ...over,
});

describe("resolveUiSlots", () => {
  it("each slot of the catalog resolves with its spec", () => {
    for (const [slot, kind] of [
      ["conversation.panel", "view"],
      ["conversation.properties.section", "view"],
      ["conversation.tool-result.card", "view"],
      ["org.page", "view"],
      ["file.preview", "embed"],
    ] as const) {
      const contribution = c({ id: "a", slot, kind });
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
    const r = resolveUiSlots([c({ id: "s", slot: "conversation.properties.section" })]);
    expect(r.resolved[0]?.after).toBe("context");
    expect(r.unknownAnchors).toEqual([]);
  });

  it("an after on a slot without anchors is reported and not kept", () => {
    const r = resolveUiSlots([c({ id: "p", slot: "org.page", after: "context" })]);
    expect(r.resolved[0]).not.toHaveProperty("after");
    expect(r.unknownAnchors).toEqual([{ id: "p", after: "context" }]);
  });

  it("keeps manifest order and accepts undefined", () => {
    expect(resolveUiSlots(undefined)).toEqual({
      resolved: [],
      dropped: [],
      unknownAnchors: [],
    });
    const r = resolveUiSlots([
      c({ id: "z", slot: "org.page" }),
      c({ id: "x", slot: "nowhere.at-all" }),
      c({ id: "a", slot: "conversation.panel" }),
    ]);
    expect(r.resolved.map((x) => x.contribution.id)).toEqual(["z", "a"]);
  });
});
