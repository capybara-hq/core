import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * The capability keys and shapes: from `SHELL_CAPABILITY_KEYS` to the SDK file's end, and in the
 * web to its first accessor (what follows there is the web's own).
 */
const shapes = (source: string, until?: string) => {
  const start = source.indexOf("export const SHELL_CAPABILITY_KEYS");
  const end = until === undefined ? source.length : source.indexOf(until);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end).trim();
};

describe("the shell capability types", () => {
  // apps/web may not import @capybara-hq/plugin-sdk, so lib/shell.ts carries a copy
  it("lib/shell.ts mirrors packages/plugin-sdk/src/shell-capabilities.ts exactly", () => {
    expect(shapes(read("../src/lib/shell.ts"), "export const useDeviceCapability")).toBe(
      shapes(read("../../../packages/plugin-sdk/src/shell-capabilities.ts")),
    );
  });
});
