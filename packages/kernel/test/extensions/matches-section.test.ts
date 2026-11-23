import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineExtension, staticManifestOf } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configToJsonSchema } from "../../src/extensions/config-json-schema.js";
import { importExtensionModule, matchesSection } from "../../src/extensions/instance.js";
import { computePermissionSet, permissionKeys } from "../../src/extensions/permission-set.js";
import { permissionGroups } from "../../src/extensions/permission-view.js";

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

describe("a module packed before core#720 (config.org, orgAccess)", () => {
  const entry = new URL("../fixtures/plugins/legacy-org/index.ts", import.meta.url);
  // the reviewed section the old packer wrote: deployment fields plus the org-only list
  const legacySection = {
    name: "legacy-org",
    version: "0.1.0",
    sdk: "^0.1.0-rc.0",
    provides: [],
    requires: [],
    optional: [],
    permissions: {},
    config: {
      deployment: [
        { path: "apiKey", secret: true, hot: false },
        { path: "region", secret: false, hot: false },
      ],
      org: [
        { path: "orgOnly", secret: false, hot: false },
        { path: "orgToken", secret: true, hot: false },
      ],
    },
  };

  it("imports, keeps only config.deployment and matches its reviewed section", async () => {
    const m = await importExtensionModule(entry.href, "legacy-org", dirname(fileURLToPath(entry)));
    expect(Object.keys(m.config ?? {})).toEqual(["deployment"]);
    expect(matchesSection(m, "legacy-org", legacySection)).toBe(true);
  });

  it("its org fields reach neither the permission set nor the config views", async () => {
    const dir = dirname(fileURLToPath(entry));
    const m = await importExtensionModule(entry.href, "legacy-org", dir);
    const set = await computePermissionSet(m, dir);
    expect(set.config).toEqual({
      deployment: [
        { path: "apiKey", secret: true },
        { path: "region", secret: false },
      ],
    });
    const everything = JSON.stringify([
      set,
      permissionKeys(set),
      permissionGroups(set),
      staticManifestOf(m),
      configToJsonSchema(m.config?.deployment as z.ZodTypeAny),
    ]);
    expect(everything).not.toMatch(/orgToken|orgOnly|x-org/);
    // orgAccess is a no-op: "readonly" made region neither read-only nor anything but overridable
    expect(everything).not.toMatch(/readonly|platform-only/i);
  });
});
