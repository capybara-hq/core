import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkTerms,
  REFERENCE_EXEMPT_PATHS,
  SDK_OLD_FORMATS_UNTIL_0B_TASK_9,
} from "../src/terms.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/terms/${name}`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** 1-based line of the first line containing `needle`. */
function lineOf(file: string, needle: string): number {
  const i = readFileSync(file, "utf8")
    .split("\n")
    .findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`"${needle}" not in ${file}`);
  return i + 1;
}

describe("checkTerms", () => {
  it("passes new names (PluginManifest is the plugin manifest), frozen names and the old formats left for Task 9", () => {
    expect(checkTerms(fixture("clean"))).toEqual([]);
  });

  it("reports each old term once, with its file and line", () => {
    const root = fixture("violations");
    const at = (rel: string, needle: string) => {
      const file = join(root, rel);
      return [file, lineOf(file, needle)];
    };
    const f = checkTerms(root);
    expect(f.map((x) => [x.rule, x.file, x.line])).toEqual([
      ["terms-sdk-api", ...at("packages/plugin-sdk/api/plugin-sdk.api.md", "definePlugin")],
      [
        "terms-sdk-api",
        ...at("packages/plugin-sdk/api/plugin-sdk.api.md", "interface StaticPluginManifest"),
      ],
      ["terms-sdk-api", ...at("packages/plugin-sdk/api/plugin-sdk.api.md", "CapabilityRef")],
      ["terms-error-code", ...at("packages/kernel/src/errors.ts", "directory.item_not_found")],
      ["terms-config-key", ...at("packages/kernel/src/config/schema.ts", "pluginHost")],
      [
        "terms-route",
        ...at("packages/kernel/src/catalog/catalog.controller.ts", "api/v1/admin/catalogs"),
      ],
      ["terms-cli", ...at("apps/capybara/src/args.ts", "capybara plugins list")],
      ["terms-reference", ...at("docs/guide.md", "CAPYBARA_PLUGIN_CONFIG")],
      ["terms-reference", ...at("docs/guide.md", "/admin/directory/requests")],
      ["terms-reference", ...at("docs/guide.md", "/settings/apps")],
      ["terms-reference", ...at("docs/guide.md", "assertPluginSecretsReachable")],
    ]);
    expect(f[0]?.message).toContain('"definePlugin"');
    expect(f[5]?.message).toContain("/marketplaces");
    expect(f[7]?.message).toContain("CAPYBARA_PLUGIN_CONFIG__OBJECT_STORE_S3__BUCKET");
  });

  it("an old-format name is reported once it leaves the Task 9 allowlist", () => {
    const root = fixture("violations");
    const api = join(root, "packages/plugin-sdk/api/plugin-sdk.api.md");
    const sdkLines = () =>
      checkTerms(root)
        .filter((x) => x.rule === "terms-sdk-api")
        .map((x) => x.line);
    expect(sdkLines()).not.toContain(lineOf(api, "PluginPackageSection"));
    SDK_OLD_FORMATS_UNTIL_0B_TASK_9.delete("PluginPackageSection");
    try {
      expect(sdkLines()).toContain(lineOf(api, "PluginPackageSection"));
    } finally {
      SDK_OLD_FORMATS_UNTIL_0B_TASK_9.add("PluginPackageSection");
    }
  });

  it("an exempt path is not searched, and is reported once its exemption is gone", () => {
    const root = fixture("violations");
    const migration = join(root, "packages/kernel/src/migrations/0040_applied.sql");
    expect(checkTerms(root).some((x) => x.file === migration)).toBe(false);
    const i = REFERENCE_EXEMPT_PATHS.findIndex((e) =>
      e.path.test("packages/kernel/src/migrations/0040_x.sql"),
    );
    const [removed] = REFERENCE_EXEMPT_PATHS.splice(i, 1);
    try {
      expect(
        checkTerms(root)
          .filter((x) => x.file === migration)
          .map((x) => x.line),
      ).toEqual([lineOf(migration, "plugin_packages")]);
    } finally {
      if (removed) REFERENCE_EXEMPT_PATHS.splice(i, 0, removed);
    }
  });

  it("the repository uses no old term", () => {
    expect(checkTerms(repoRoot)).toEqual([]);
  });
});
