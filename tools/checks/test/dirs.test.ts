import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pluginChecks } from "@capybara-hq/plugin-tools";
import { describe, expect, it } from "vitest";
import {
  corePluginScope,
  extensionDirs,
  fakeExtensionDirs,
  migrationDirs,
  pluginDirs,
  toolDesignDirs,
} from "../src/cli/dirs.js";
import { root } from "../src/cli/report.js";

const FAKES = join(root, "packages/testing/fixtures/extensions");

describe("scan scope of the plugin-scoped checks", () => {
  it("covers every plugin and every fake extension of @capybara-hq/testing", () => {
    const fakes = readdirSync(FAKES, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(FAKES, e.name))
      .sort();
    expect(fakes.length).toBeGreaterThan(0);
    expect(fakeExtensionDirs()).toEqual(fakes);
    expect(extensionDirs()).toEqual([...pluginDirs(), ...fakes]);
    expect(toolDesignDirs(extensionDirs())).toEqual(expect.arrayContaining(fakes));
  });

  it("checks the migrations of the fake extensions", () => {
    expect(migrationDirs()).toContain(join(FAKES, "fake-tools-ui", "migrations"));
  });

  it("core's plugin-tools scope: every extension dir, the SDK boundary, builtins, kernel migrations", () => {
    const scope = corePluginScope();
    expect(scope.plugins).toEqual(extensionDirs());
    expect(scope.sdkDirs).toEqual([join(root, "packages/plugin-sdk")]);
    expect(scope.toolDesignDirs).toEqual([join(root, "packages/kernel/src/tools/builtins")]);
    expect(scope.migrationDirs).toContain(join(root, "packages/kernel/src/migrations"));
    // pluginChecks adds <plugin>/migrations itself; together they are exactly migrationDirs().
    const own = scope.plugins.map((p) => join(p, "migrations"));
    expect([...(scope.migrationDirs ?? []), ...own].sort()).toEqual(migrationDirs().sort());
    expect(pluginChecks(scope).map((c) => c.name)).toEqual([
      "Migrations",
      "Dependency boundary",
      "Extension state",
      "Extension permissions",
      "Plugin pack",
      "Tool design",
      "Plugin test imports",
      "Plugin release metadata",
    ]);
    expect(scope.root).toBe(root);
  });
});
