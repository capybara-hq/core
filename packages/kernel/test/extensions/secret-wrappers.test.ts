import { type ExtensionManifest, platformOnly, secret, ui } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configFields, secretValues, unreachableSecrets } from "../../src/config/fields.js";
import { deploymentConfigHash } from "../../src/extensions/config-hash.js";
import {
  mergeCopy,
  overrideSecretPaths,
  platformOverrideValues,
  secretLeafPaths,
} from "../../src/extensions/effective-config.js";
import { assertSecretsReachable } from "../../src/extensions/host.js";
import { fieldLevels } from "../../src/extensions/org-levels.js";

const hints = { label: { zh: "密钥", en: "Key" } };

/** Each ordering of the marks, with the outer mark on a wrapper or on the leaf. */
const platformSecrets: Record<string, () => z.ZodTypeAny> = {
  "platformOnly(ui(secret(x)).optional())": () =>
    platformOnly(ui(secret(z.string()), hints).optional()),
  "platformOnly(ui(secret(x))).optional()": () =>
    platformOnly(ui(secret(z.string()), hints)).optional(),
  "platformOnly(secret(x).optional())": () => platformOnly(secret(z.string()).optional()),
  "secret(platformOnly(x).optional())": () => secret(platformOnly(z.string()).optional()),
  "platformOnly(secret(x).default())": () => platformOnly(secret(z.string()).default("dflt")),
  "secret(platformOnly(x).default())": () => secret(platformOnly(z.string()).default("dflt")),
  "platformOnly(secret(x).nullable().optional())": () =>
    platformOnly(secret(z.string()).nullable().optional()),
  "secret(platformOnly(x).prefault())": () => secret(platformOnly(z.string()).prefault("dflt")),
  "platformOnly(secret(x).catch(dflt).readonly())": () =>
    platformOnly(secret(z.string()).catch("dflt").readonly()),
  // raw meta, as a hand-made schema or another SDK version writes it: no merge by the helpers
  "x.meta(secret).optional().meta(platformOnly)": () =>
    z.string().meta({ secret: true }).optional().meta({ platformOnly: true }),
  "x.meta(secret).default().meta(platformOnly, ui)": () =>
    z.string().meta({ secret: true }).default("dflt").meta({ platformOnly: true, ui: hints }),
};

const manifestOf = (deployment: z.ZodTypeAny): ExtensionManifest =>
  ({ name: "wrap-test", config: { deployment } }) as unknown as ExtensionManifest;

describe("secret marks under or over wrappers (kernel)", () => {
  for (const [name, make] of Object.entries(platformSecrets)) {
    it(`${name}: loads, is a secret leaf, masked and hashed as a secret`, () => {
      const schema = z.object({ key: make(), open: z.string().optional() });
      expect(unreachableSecrets(schema)).toEqual([]);
      expect(() => assertSecretsReachable(manifestOf(schema))).not.toThrow();
      const byPath = new Map(configFields(schema).map((f) => [f.path, f.meta]));
      expect(byPath.get("key")?.secret).toBe(true);
      expect(byPath.get("open")?.secret).toBeFalsy();
      expect(secretLeafPaths(schema)).toEqual(["key"]);
      expect(secretValues(schema, { key: "s3cr3t-value", open: "o" })).toEqual(["s3cr3t-value"]);
      // only the secret differs: the non-secret digest is the same
      expect(deploymentConfigHash(schema, { key: "a", open: "o" })).toBe(
        deploymentConfigHash(schema, { key: "b", open: "o" }),
      );
      // a platform-only secret: never part of a copy, still reaches the org's effective config
      expect(overrideSecretPaths(schema)).toEqual([]);
      expect(platformOverrideValues(schema, { key: "plat", open: "o" })).toEqual({ open: "o" });
      expect(
        mergeCopy(schema, { key: "plat", open: "o" }, { config: { open: "x" }, secrets: {} }),
      ).toEqual({ key: "plat", open: "x" });
    });
  }

  it("an overridable secret with ui on its optional wrapper stays out of copies", () => {
    const schema = z.object({
      key: ui(secret(z.string()).optional(), hints),
      open: z.string().optional(),
    });
    expect(() => assertSecretsReachable(manifestOf(schema))).not.toThrow();
    expect(overrideSecretPaths(schema)).toEqual(["key"]);
    // the platform's secret never enters a new copy, nor a copy without its own
    expect(platformOverrideValues(schema, { key: "plat", open: "o" })).toEqual({ open: "o" });
    expect(
      mergeCopy(
        schema,
        { key: "plat", open: "o" },
        { config: { key: "hand-edited", open: "x" }, secrets: {} },
      ),
    ).toEqual({ open: "x" });
  });

  it("an inner platformOnly true is never cleared by an outer false", () => {
    const schema = z.object({
      key: platformOnly(z.string()).optional().meta({ platformOnly: false }),
    });
    expect(fieldLevels(schema).get("key")).toBe("platform");
  });

  it("a hot mark on the leaf survives a wrapper's meta", () => {
    const schema = z.object({
      level: z.string().meta({ hot: true }).optional().meta({ ui: hints }),
    });
    expect(configFields(schema)[0]?.meta?.hot).toBe(true);
  });
});
