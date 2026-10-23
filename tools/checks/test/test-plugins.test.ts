import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkTestPlugins } from "../src/test-plugins.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/test-plugins/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** 1-based line of the `// MARK <name>` comment. */
function marked(file: string, name: string): number {
  const i = readFileSync(file, "utf8")
    .split("\n")
    .findIndex((l) => l.includes(`// MARK ${name}`));
  if (i < 0) throw new Error(`no MARK ${name} in ${file}`);
  return i + 1;
}

describe("checkTestPlugins", () => {
  it("passes when every referenced plugin is mapped or declared, ignoring look-alikes", () => {
    expect(checkTestPlugins(fixture("clean"))).toEqual([]);
  });

  it("reports undeclared, dynamic and stale / unknown / redundant mapping entries", () => {
    const root = fixture("violations");
    const test = join(root, "packages/core/test/uses.test.ts");
    const mapping = join(root, "tools/ci/test-plugins.json");
    const f = checkTestPlugins(root);

    const inTest = f.filter((x) => x.file === test).sort((a, b) => a.line - b.line);
    expect(inTest.map((x) => [x.rule, x.line])).toEqual([
      ["test-plugin-undeclared", marked(test, "import-beta")],
      ["test-plugin-undeclared", marked(test, "root-beta")],
      ["test-plugin-dynamic", marked(test, "dynamic")],
    ]);
    expect(inTest[0]?.message).toContain('add "beta" to "packages/core/test"');

    const inMapping = f.filter((x) => x.file === mapping);
    expect(inMapping.every((x) => x.rule === "test-plugin-mapping")).toBe(true);
    const messages = inMapping.map((x) => x.message);
    expect(messages).toEqual([
      expect.stringContaining("no file under packages/core/test references plugins/alpha"),
      expect.stringContaining('"delta" is not a directory under plugins/'),
      expect.stringContaining("already depends on plugins/gamma"),
      expect.stringContaining('"packages/nope/test" must be an existing'),
    ]);
    expect(f).toHaveLength(inTest.length + inMapping.length);
  });

  it("the real repo passes", () => {
    expect(checkTestPlugins(repoRoot)).toEqual([]);
  });
});
