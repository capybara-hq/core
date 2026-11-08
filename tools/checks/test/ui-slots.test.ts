import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UI_SLOTS } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkUiSlots,
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
    ] as const) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
    expect(checkUiSlots(dir)).toEqual([]);
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
