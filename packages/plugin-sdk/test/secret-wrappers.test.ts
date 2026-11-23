import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  configJsonSchema,
  defineExtension,
  isPlatformOnly,
  isSecret,
  platformOnly,
  secret,
  staticManifestOf,
  ui,
} from "../src/index.js";

const hints = { label: { zh: "密钥", en: "Key" } };

/** Every ordering of secret / platformOnly / ui with the mark on the leaf or on a wrapper. */
const orderings: Record<string, () => z.ZodTypeAny> = {
  "platformOnly(ui(secret(x)).optional())": () =>
    platformOnly(ui(secret(z.string()), hints).optional()),
  "platformOnly(ui(secret(x))).optional()": () =>
    platformOnly(ui(secret(z.string()), hints)).optional(),
  "platformOnly(secret(x).optional())": () => platformOnly(secret(z.string()).optional()),
  "secret(platformOnly(x).optional())": () => secret(platformOnly(z.string()).optional()),
  "platformOnly(secret(x).default())": () => platformOnly(secret(z.string()).default("v")),
  "secret(platformOnly(x).default())": () => secret(platformOnly(z.string()).default("v")),
  "ui(platformOnly(secret(x).nullable().optional()))": () =>
    ui(platformOnly(secret(z.string()).nullable().optional()), hints),
  "secret(ui(platformOnly(x).prefault()))": () =>
    secret(ui(platformOnly(z.string()).prefault("v"), hints)),
  "platformOnly(secret(x).catch().readonly())": () =>
    platformOnly(secret(z.string()).catch("v").readonly()),
};

describe("secret and platformOnly marks through wrappers", () => {
  for (const [name, make] of Object.entries(orderings)) {
    describe(name, () => {
      it("isSecret and isPlatformOnly are both true", () => {
        const f = make();
        expect(isSecret(f)).toBe(true);
        expect(isPlatformOnly(f)).toBe(true);
      });

      it("the JSON Schema carries x-secret and x-platform-only and no default", () => {
        const js = configJsonSchema(z.object({ f: make() })) as {
          properties: Record<string, Record<string, unknown>>;
        };
        const f = js.properties.f;
        expect(f?.["x-secret"]).toBe(true);
        expect(f?.["x-platform-only"]).toBe(true);
        expect(f?.default).toBeUndefined();
      });

      it("the static manifest lists the field as a secret", () => {
        const m = defineExtension({
          name: "wrap-test",
          version: "1.0.0",
          sdk: "^0.1.0-rc.0",
          provides: [],
          config: { deployment: z.object({ f: make(), open: z.string().optional() }) },
          setup() {},
        });
        expect(staticManifestOf(m).config.deployment).toEqual([
          { path: "f", secret: true, hot: false },
          { path: "open", secret: false, hot: false },
        ]);
      });
    });
  }

  it("the helpers keep each other's keys when the outer one sits on a wrapper", () => {
    const f = platformOnly(ui(secret(z.string()), hints).optional());
    expect(f.meta()).toMatchObject({ secret: true, platformOnly: true, ui: hints });
    const g = ui(secret(platformOnly(z.string()).default("v")), hints);
    expect(g.meta()).toMatchObject({ secret: true, platformOnly: true, ui: hints });
  });

  it("an overridable secret with ui on its wrapper stays a secret", () => {
    const f = ui(secret(z.string()).optional(), hints);
    expect(isSecret(f)).toBe(true);
    expect(isPlatformOnly(f)).toBe(false);
  });

  it("never publishes the default of a wrapper around a secret", () => {
    const js = configJsonSchema(z.object({ f: secret(z.string()).nullable().default("v") })) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(js.properties.f?.["x-secret"]).toBe(true);
    expect(JSON.stringify(js)).not.toContain('"v"');
  });

  it("isSecret is false without the mark anywhere in the wrapper chain", () => {
    expect(isSecret(ui(platformOnly(z.string()).optional(), hints))).toBe(false);
  });
});
