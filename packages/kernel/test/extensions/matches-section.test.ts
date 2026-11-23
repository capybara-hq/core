import { defineExtension, staticManifestOf } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { matchesSection } from "../../src/extensions/instance.js";

const manifest = defineExtension({
  name: "legacy-section",
  version: "1.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: { deployment: z.object({ url: z.string() }) },
  setup: async () => {},
});

describe("matchesSection", () => {
  it("matches the module's own static manifest", () => {
    expect(matchesSection(manifest, "legacy-section", staticManifestOf(manifest))).toBe(true);
  });

  it("accepts a reviewed section packed before core#720 that still carries config.org", () => {
    const current = staticManifestOf(manifest);
    for (const org of [[], [{ path: "token", secret: true, hot: false }]]) {
      const legacy = { ...current, config: { ...current.config, org } };
      expect(matchesSection(manifest, "legacy-section", legacy)).toBe(true);
    }
  });

  it("still refuses a section whose deployment fields differ", () => {
    const current = staticManifestOf(manifest);
    const other = {
      ...current,
      config: { deployment: [{ path: "other", secret: false, hot: false }], org: [] },
    };
    expect(matchesSection(manifest, "legacy-section", other)).toBe(false);
  });

  it("still refuses another name", () => {
    expect(matchesSection(manifest, "other", staticManifestOf(manifest))).toBe(false);
  });
});
