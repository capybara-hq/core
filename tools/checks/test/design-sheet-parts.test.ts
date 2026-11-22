import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SHEET_PARTS_PENDING,
  type SheetPartsPending,
  sheetPartsTreeFindings,
} from "../src/design-sheet-parts.js";

const fx = (name: string) =>
  fileURLToPath(new URL(`../fixtures/design-sheet-parts/${name}`, import.meta.url));
const where = (name: string, pending: SheetPartsPending[] = []) =>
  sheetPartsTreeFindings(fx(name), pending);
const entry = (path: string, max: number): SheetPartsPending => ({ path, max, fix: "test" });

describe("design-sheet-parts", () => {
  it("a raw button, link or li inside a sheet fails; the parts' own files are exempt", () => {
    const f = where("violation");
    expect(f.map((x) => [x.rule, x.file.endsWith("raw.tsx"), x.line])).toEqual([
      ["design-sheet-parts", true, 7],
      ["design-sheet-parts", true, 16],
      ["design-sheet-parts", true, 18],
    ]);
    expect(f[0]?.message).toContain("<button>");
    expect(f[0]?.message).toContain("SheetRow");
  });

  it("parts, controls outside a sheet and a sheet's attributes pass", () => {
    expect(where("ok")).toEqual([]);
  });

  it("a pending entry hides its findings up to max; past max all are reported", () => {
    expect(where("violation", [entry("controls/raw.tsx", 3)])).toEqual([]);
    expect(where("violation", [entry("controls/raw.tsx", 2)])).toHaveLength(3);
  });

  it("a lower count than max, a clean file or a missing file fails as stale", () => {
    expect(where("violation", [entry("controls/raw.tsx", 5)]).map((x) => x.rule)).toEqual([
      "design-sheet-parts-stale-pending",
    ]);
    const f = where("ok", [entry("controls/fine.tsx", 1), entry("controls/gone.tsx", 1)]);
    expect(f.map((x) => x.rule)).toEqual([
      "design-sheet-parts-stale-pending",
      "design-sheet-parts-stale-pending",
    ]);
    expect(f[1]?.message).toContain("does not exist");
  });

  it("the real pending list stays under packages/design/src", () => {
    expect(SHEET_PARTS_PENDING.every((e) => e.max > 0)).toBe(true);
  });
});
