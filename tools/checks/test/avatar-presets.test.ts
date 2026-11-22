import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_AVATAR_PRESET_IDS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";

/**
 * The built-in avatar presets (theme brand coverage spec §4): the kernel accepts the SDK's list,
 * the design package draws its own copy (it imports no `@capybara-hq/*`). Both must hold the same
 * ids in the same order (the picker's order). The design list is read from its source: design is
 * a browser package (extensionless imports) the node test build does not compile.
 */
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const DESIGN_FILE = "packages/design/src/display/avatar-presets.ts";

/** The string literals of `export const AVATAR_PRESET_IDS = [ … ]` in `source`; null if absent. */
function designPresetIds(source: string): string[] | null {
  const m = /export const AVATAR_PRESET_IDS = \[([^\]]*)\]/.exec(source);
  return m ? [...(m[1] ?? "").matchAll(/"([^"]*)"/g)].map((x) => x[1] ?? "") : null;
}

const sameList = (a: readonly string[] | null, b: readonly string[]): boolean =>
  a !== null && a.length === b.length && a.every((id, i) => id === b[i]);

describe("built-in avatar presets", () => {
  it("the design AVATAR_PRESET_IDS equal the SDK's BUILTIN_AVATAR_PRESET_IDS in order", () => {
    const ids = designPresetIds(readFileSync(join(repoRoot, DESIGN_FILE), "utf8"));
    expect(ids).toEqual([...BUILTIN_AVATAR_PRESET_IDS]);
    expect(sameList(ids, BUILTIN_AVATAR_PRESET_IDS)).toBe(true);
  });

  it("a reordered copy does not match", () => {
    const [first, second, ...rest] = BUILTIN_AVATAR_PRESET_IDS;
    const reordered = [second, first, ...rest].map((id) => `  "${id}",`).join("\n");
    const ids = designPresetIds(`export const AVATAR_PRESET_IDS = [\n${reordered}\n] as const;`);
    expect(ids).toHaveLength(BUILTIN_AVATAR_PRESET_IDS.length);
    expect(sameList(ids, BUILTIN_AVATAR_PRESET_IDS)).toBe(false);
    expect(sameList(BUILTIN_AVATAR_PRESET_IDS.slice(1), BUILTIN_AVATAR_PRESET_IDS)).toBe(false);
    expect(designPresetIds("export const OTHER = [];")).toBeNull();
  });
});
