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
    expect(shapes(read("../src/lib/shell.ts"), "export const useNotifyCapability")).toBe(
      shapes(read("../../../packages/plugin-sdk/src/shell-capabilities.ts")),
    );
  });
});

describe("the nav@1 limits", () => {
  // packages/design may not import @capybara-hq/plugin-sdk either, so native.ts keeps its own copy
  it("design's NATIVE_NAV_LIMITS equal the SDK's MOBILE_SHELL_LIMITS navLabel / navCount", () => {
    const sdk = read("../../../packages/plugin-sdk/src/shell-capabilities.ts");
    const design = read("../../../packages/design/src/native.ts");
    const num = (source: string, re: RegExp) => Number(re.exec(source)?.[1]);
    const label = num(sdk, /navLabel: (\d+)/);
    const count = num(sdk, /navCount: (\d+)/);
    expect(label).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(0);
    expect(design).toContain(
      `export const NATIVE_NAV_LIMITS = { label: ${label}, count: ${count} } as const;`,
    );
  });

  it("design's NATIVE_NAV_ACCOUNT_NAME equals the SDK's navAccountName", () => {
    const sdk = read("../../../packages/plugin-sdk/src/shell-capabilities.ts");
    const design = read("../../../packages/design/src/native.ts");
    const name = Number(/navAccountName: (\d+)/.exec(sdk)?.[1]);
    expect(name).toBeGreaterThan(0);
    expect(design).toContain(`export const NATIVE_NAV_ACCOUNT_NAME = ${name};`);
  });
});
