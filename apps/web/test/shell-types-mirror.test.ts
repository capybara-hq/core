import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The capability shapes, from `KeepAwakeMode` through the last capability interface. */
const shapes = (source: string) => {
  const start = source.indexOf("export type KeepAwakeMode");
  const last = source.indexOf("export interface SignInCapabilityV1");
  const end = source.indexOf("\n}\n", last);
  expect(start).toBeGreaterThan(-1);
  expect(last).toBeGreaterThan(start);
  return source.slice(start, end + 2);
};

describe("the shell capability types", () => {
  // apps/web may not import @capybara-hq/plugin-sdk, so lib/shell.ts carries a copy
  it("lib/shell.ts mirrors packages/plugin-sdk/src/shell-capabilities.ts exactly", () => {
    expect(shapes(read("../src/lib/shell.ts"))).toBe(
      shapes(read("../../../packages/plugin-sdk/src/shell-capabilities.ts")),
    );
  });
});
