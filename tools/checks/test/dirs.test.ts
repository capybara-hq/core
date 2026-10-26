import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
});
