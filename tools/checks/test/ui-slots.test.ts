import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_SLOTS, type UiSlotSpec } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkUiSlots,
  PLUGIN_CLIENT_SLOTS_TS,
  renderPluginClientSlotsTs,
  renderUiSlotsDoc,
  renderUiSlotsTs,
  UI_SLOTS_DOC,
  UI_SLOTS_TS,
} from "../src/ui-slots.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/ui-slots/${name}`, import.meta.url));

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("check:ui-slots", () => {
  it("a stale web copy reports ui-slots-stale naming the file", () => {
    const findings = checkUiSlots(fixture("stale"));
    expect(findings.some((f) => f.rule === "ui-slots-stale")).toBe(true);
    expect(findings.some((f) => f.file.endsWith("ui-slots.generated.ts"))).toBe(true);
  });

  it("a current root reports nothing", () => {
    // Rendered at test time: a static copy would go stale with every catalog change.
    const dir = mkdtempSync(join(tmpdir(), "ui-slots-"));
    tmp.push(dir);
    for (const [rel, text] of [
      [UI_SLOTS_TS, renderUiSlotsTs(UI_SLOTS)],
      [UI_SLOTS_DOC, renderUiSlotsDoc(UI_SLOTS)],
      [PLUGIN_CLIENT_SLOTS_TS, renderPluginClientSlotsTs(UI_SLOTS)],
    ] as const) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    expect(checkUiSlots(dir).filter((f) => f.rule === "ui-slots-stale")).toEqual([]);
  });

  it("renders one table row and one section per slot", () => {
    const doc = renderUiSlotsDoc(UI_SLOTS);
    for (const s of UI_SLOTS) {
      expect(doc).toContain(`| \`${s.id}\` |`);
      expect(doc).toContain(`## \`${s.id}\``);
    }
    expect(renderUiSlotsTs(UI_SLOTS)).toContain("export const UI_SLOT_SPECS");
  });
});

describe("check:ui-slots render rules", () => {
  const slot = (id: string, owner: string) => ({ id, owner }) as unknown as UiSlotSpec;
  const one = [slot("x.one", "a.tsx")];
  const two = [slot("x.one", "a.tsx"), slot("x.two", "b.tsx")];
  const rules = (name: string, slots: readonly UiSlotSpec[]) =>
    checkUiSlots(fixture(name), slots).map((f) => f.rule);

  it("a catalog slot nothing renders -> ui-slot-unrendered", () => {
    expect(rules("unrendered", two)).toEqual(["ui-slot-unrendered"]);
  });
  it("a literal that is not a catalog id -> ui-slot-undeclared", () => {
    expect(rules("undeclared", one)).toEqual(["ui-slot-undeclared"]);
  });
  it("a slot rendered outside its owner file -> ui-slot-owner", () => {
    expect(rules("owner", one)).toEqual(["ui-slot-owner"]);
  });
  it("a slot rendered twice -> ui-slot-twice", () => {
    expect(rules("twice", one)).toEqual(["ui-slot-twice"]);
  });
  it("a computed slot name -> ui-slot-literal", () => {
    expect(rules("dynamic", one)).toEqual(["ui-slot-literal"]);
  });
  it("anchor renders of one slot count once; dev/ is skipped", () => {
    expect(rules("anchors-ok", one)).toEqual([]);
    expect(rules("ok", one)).toEqual([]);
  });
  it("the real tree renders every slot once, in its owner", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    expect(checkUiSlots(root)).toEqual([]);
  });
});
