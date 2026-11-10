import { describe, expect, it } from "vitest";
import {
  PLACE_SLOTS,
  parseSlotRef,
  UI_ARRANGEABLE_SLOTS,
  UI_COMPONENT_SLOTS,
  UI_CONTRIBUTION_KEY_RE,
  UI_SINGLE_SLOTS,
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

  it("PLACE_SLOTS maps each deprecated place to its slot", () => {
    expect(PLACE_SLOTS).toEqual({
      panel: "conversation.panel",
      conversation: "conversation.panel",
      section: "conversation.properties.section",
      inline: "conversation.tool-result.card",
      page: "org.page",
      "file-preview": "file.preview",
    });
  });

  it("UI_ARRANGEABLE_SLOTS lists every slot but file.preview, in catalog order", () => {
    expect([...UI_ARRANGEABLE_SLOTS]).toEqual([
      "conversation.panel",
      "conversation.properties.section",
      "conversation.tool-result.card",
      "org.page",
      "agent.detail.section",
      "org.settings.section",
      "platform.page",
      "shell.brand",
      "shell.overlay",
      "conversation.empty",
      "conversation.composer.frame",
    ]);
  });

  it("UI_CONTRIBUTION_KEY_RE accepts <extension>/<contribution> keys only", () => {
    for (const ok of ["todo/board", "ab/c", "my-plugin/tasks-panel", `a${"b".repeat(40)}/x`]) {
      expect(UI_CONTRIBUTION_KEY_RE.test(ok)).toBe(true);
    }
    for (const bad of [
      "todo",
      "a/board",
      "Todo/board",
      "todo/Board",
      "todo/1board",
      "todo/",
      "todo/board/x",
      `a${"b".repeat(41)}/x`,
      `todo/a${"b".repeat(40)}`,
    ]) {
      expect(UI_CONTRIBUTION_KEY_RE.test(bad)).toBe(false);
    }
    expect(UI_CONTRIBUTION_KEY_RE.test(uiContributionKey("todo", "board"))).toBe(true);
  });

  it("builds contribution keys", () => {
    expect(uiContributionKey("todo", "board")).toBe("todo/board");
  });
});

describe("component kind and single slots", () => {
  const NEW = ["shell.brand", "shell.overlay", "conversation.empty", "conversation.composer.frame"];

  it("single slots are replaceable, name their builtin and accept only component", () => {
    const singles = UI_SLOTS.filter((s) => s.cardinality === "single");
    expect(singles.map((s) => s.id)).toEqual([...UI_SINGLE_SLOTS]);
    expect(singles.length).toBe(3);
    for (const s of singles) {
      expect(s.replaceable).toBe(true);
      expect(s.builtin?.en.length).toBeGreaterThan(0);
      expect(s.builtin?.zh.length).toBeGreaterThan(0);
      expect([...s.accepts]).toEqual(["component"]);
      expect(s.anchors).toBeUndefined();
      expect(s.limits).toBeUndefined();
    }
  });

  it("list slots carry no replaceable or builtin", () => {
    for (const s of UI_SLOTS.filter((x) => x.cardinality === "list")) {
      expect(s.replaceable).toBeUndefined();
      expect(s.builtin).toBeUndefined();
    }
  });

  it("the four new slots have the spec's owners and scope", () => {
    expect(UI_SLOT_IDS.slice(-4)).toEqual(NEW);
    const owners: Record<string, string> = {
      "shell.brand": "components/shell/AppFrame.tsx",
      "shell.overlay": "components/shell/AppFrame.tsx",
      "conversation.empty": "components/conversation/NewConversation.tsx",
      "conversation.composer.frame": "components/conversation/ComposerBar.tsx",
    };
    for (const id of NEW) {
      const s = uiSlot(id);
      expect(s?.owner).toBe(owners[id]);
      expect(s?.scope).toBe("org");
      expect(s?.minRole).toBe("guest");
      expect([...(s?.accepts ?? [])]).toEqual(["component"]);
    }
    expect(uiSlot("shell.overlay")?.cardinality).toBe("list");
    expect(uiSlot("shell.overlay")?.limits?.maxShown).toBe(4);
  });

  it("file.preview does not accept component", () => {
    expect([...(uiSlot("file.preview")?.accepts ?? [])]).toEqual(["embed"]);
  });

  it("the seven L1 slots accept component", () => {
    const l1 = [
      "conversation.panel",
      "conversation.properties.section",
      "conversation.tool-result.card",
      "org.page",
      "agent.detail.section",
      "org.settings.section",
      "platform.page",
    ];
    for (const id of l1) expect(uiSlot(id)?.accepts).toContain("component");
    expect([...UI_COMPONENT_SLOTS]).toEqual([...l1, ...NEW]);
  });

  it("zh descriptions of the new rows avoid 企业 and the word agent", () => {
    for (const id of NEW) {
      const s = uiSlot(id);
      const text = [s?.description.zh, s?.builtin?.zh].join(" ");
      expect(text).not.toMatch(/企业|agent/i);
    }
  });
});
