import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncPluginVersions } from "../src/check/plugin-versions.js";

function plugin(root: string, name: string, pkg: string, manifest: string, src?: string) {
  const dir = join(root, "plugins", name);
  mkdirSync(join(dir, ".capybara-plugin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@x/${name}`, version: pkg }));
  writeFileSync(
    join(dir, ".capybara-plugin/plugin.json"),
    `${JSON.stringify({ schemaVersion: 1, name, version: manifest }, null, 2)}\n`,
  );
  if (src !== undefined) {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src/index.ts"), src);
  }
}

const ext = (v: string) =>
  `export default defineExtension({\n  name: "a",\n  version: "${v}",\n  sdk: "^0.1.0",\n  setup() {\n    return { version: "inner" };\n  },\n});\n`;

describe("syncPluginVersions", () => {
  it("rewrites plugin.json and the extension manifest version to the package.json version", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-versions-"));
    try {
      plugin(root, "a", "0.2.0", "0.1.0", ext("0.1.0"));
      plugin(root, "b", "0.1.0", "0.1.0", ext("0.1.0"));
      plugin(root, "skills-only", "1.0.1", "1.0.0");
      expect(syncPluginVersions(root)).toEqual([
        "plugins/a/.capybara-plugin/plugin.json",
        "plugins/a/src/index.ts",
        "plugins/skills-only/.capybara-plugin/plugin.json",
      ]);
      const a = JSON.parse(
        readFileSync(join(root, "plugins/a/.capybara-plugin/plugin.json"), "utf8"),
      );
      expect(a).toEqual({ schemaVersion: 1, name: "a", version: "0.2.0" });
      expect(readFileSync(join(root, "plugins/a/src/index.ts"), "utf8")).toBe(ext("0.2.0"));
      // Idempotent: a second run changes nothing.
      expect(syncPluginVersions(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when the extension manifest version line cannot be found unambiguously", () => {
    const root = mkdtempSync(join(tmpdir(), "plugin-versions-"));
    try {
      plugin(root, "a", "0.2.0", "0.2.0", "export default defineExtension(manifest);\n");
      expect(() => syncPluginVersions(root)).toThrow(
        /plugins\/a\/src\/index.ts: expected exactly one/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
