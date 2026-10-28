import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPluginTestImports } from "../src/check/test-imports.js";
import { discoverPlugins } from "../src/discover.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));

describe("plugin-test-imports", () => {
  const dir = fixture("plugin-test-imports");
  const file = join(dir, "test/kernel/moved.test.ts");
  const findings = checkPluginTestImports([dir]);

  it("reports exactly the lines marked FLAG: core imports, paths and package names", () => {
    const flagged = readFileSync(file, "utf8")
      .split("\n")
      .flatMap((l, i) => (l.includes("// FLAG") ? [i + 1] : []));
    expect(flagged).toHaveLength(11);
    expect(findings.every((f) => f.file === file && f.rule === "plugin-test-imports")).toBe(true);
    expect(findings.map((f) => f.line).sort((a, b) => a - b)).toEqual(flagged);
  });

  it("names what it found and the way out", () => {
    const at = (mark: string) => {
      const line =
        readFileSync(file, "utf8")
          .split("\n")
          .findIndex((l) => l.includes(`// FLAG ${mark}`)) + 1;
      return findings.find((f) => f.line === line)?.message ?? "";
    };
    expect(at("kernel-import")).toContain("imports @capybara-hq/kernel");
    expect(at("name-string")).toContain("names the package @capybara-hq/kernel");
    expect(at("bare-dotdot")).toContain('".." segments of this join()');
    expect(at("rooted-path")).toContain("is a path into core");
    expect(at("kernel-import")).toContain("@capybara-hq/testing");
  });

  it("the plugins of this repository pass", () => {
    expect(checkPluginTestImports(discoverPlugins(repo))).toEqual([]);
  });
});
