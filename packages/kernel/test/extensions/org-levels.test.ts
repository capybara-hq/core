import { platformOnly, secret } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseDeploymentConfig } from "../../src/extensions/cli.js";
import {
  fieldLevels,
  jsonSchemaFieldLevels,
  missingOverridable,
  parseLoadGate,
  relaxOverridable,
} from "../../src/extensions/org-levels.js";
import { OrglevelsDeploymentSchema } from "../fixtures/plugins/orglevels/index.js";
import { OrgrefinedDeploymentSchema } from "../fixtures/plugins/orgrefined/index.js";
import { OrgwrappedDeploymentSchema } from "../fixtures/plugins/orgwrapped/index.js";

describe("org field levels (spec A §5.1, §5.4a)", () => {
  it("fieldLevels: an unmarked top-level key is override, a platformOnly key is platform", () => {
    expect(Object.fromEntries(fieldLevels(OrglevelsDeploymentSchema))).toEqual({
      host: "platform",
      limit: "override",
      baseUrl: "override",
      apiKey: "override",
    });
  });

  it("fieldLevels: a platformOnly root makes every key platform, marked again or not", () => {
    const s = platformOnly(z.object({ a: z.string(), b: platformOnly(z.number()) }));
    expect(Object.fromEntries(fieldLevels(s))).toEqual({ a: "platform", b: "platform" });
    expect(missingOverridable(s, {})).toEqual([]);
    expect(parseLoadGate(s, {}).success).toBe(false);
  });

  it("fieldLevels of a schema that is not an object, or none, is empty", () => {
    expect(fieldLevels(undefined).size).toBe(0);
    expect(fieldLevels(z.string()).size).toBe(0);
  });

  it("relaxOverridable makes overridable keys optional and keeps the rest required", () => {
    const relaxed = relaxOverridable(OrglevelsDeploymentSchema);
    expect(OrglevelsDeploymentSchema.safeParse({ host: "h" }).success).toBe(false);
    expect(relaxed.safeParse({ host: "h" })).toEqual({
      success: true,
      data: { host: "h", limit: 5 },
    });
    // a platform-only field stays required
    expect(relaxed.safeParse({}).success).toBe(false);
    // a value present must still be valid
    expect(relaxed.safeParse({ host: "h", baseUrl: "not a url" }).success).toBe(false);
  });

  it("relaxOverridable is the identity without overridable keys", () => {
    const s = z.object({ a: platformOnly(z.string()) });
    expect(relaxOverridable(s)).toBe(s);
    const str = z.string();
    expect(relaxOverridable(str)).toBe(str);
  });

  it("missingOverridable lists the required overridable keys left empty, in schema order", () => {
    expect(missingOverridable(OrglevelsDeploymentSchema, { host: "h" })).toEqual([
      "baseUrl",
      "apiKey",
    ]);
    expect(
      missingOverridable(OrglevelsDeploymentSchema, { host: "h", baseUrl: "https://x" }),
    ).toEqual(["apiKey"]);
    const optional = z.object({
      a: z.object({}).optional(),
      b: z.string().optional(),
    });
    expect(missingOverridable(optional, {})).toEqual([]);
    // an unmarked required key the platform leaves empty is listed; a platform-only one is not
    const mixed = z.object({ host: platformOnly(z.string()), region: z.string() });
    expect(missingOverridable(mixed, {})).toEqual(["region"]);
  });

  it("parseLoadGate accepts an empty required secret (overridable) but not an empty platform-only field", () => {
    expect(parseLoadGate(z.object({ apiKey: secret(z.string()) }), {})).toEqual({
      success: true,
      data: {},
    });
    expect(parseLoadGate(z.object({ host: platformOnly(z.string()) }), {}).success).toBe(false);
  });

  it("jsonSchemaFieldLevels reads x-platform-only of the root and top-level properties", () => {
    expect(
      Object.fromEntries(
        jsonSchemaFieldLevels({
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string", "x-platform-only": true },
            c: { type: "string", "x-platform-only": false },
            // a removed annotation means nothing
            d: { type: "string", "x-org": "readonly" },
          },
        }),
      ),
    ).toEqual({ a: "override", b: "platform", c: "override", d: "override" });
    expect(
      Object.fromEntries(
        jsonSchemaFieldLevels({
          type: "object",
          "x-platform-only": true,
          properties: { a: { type: "string" }, b: { type: "string" } },
        }),
      ),
    ).toEqual({ a: "platform", b: "platform" });
    expect(jsonSchemaFieldLevels(undefined).size).toBe(0);
  });
});

describe("the load gate on a refined deployment schema (spec A §5.4a)", () => {
  it("relaxOverridable does not throw on an object-level refinement", () => {
    expect(() => relaxOverridable(OrgrefinedDeploymentSchema)).not.toThrow();
  });

  it("an empty overridable field passes, without running the refinement", () => {
    expect(parseLoadGate(OrgrefinedDeploymentSchema, { mode: "strict" })).toEqual({
      success: true,
      data: { mode: "strict" },
    });
    // a platform-only field is still required
    expect(parseLoadGate(OrgrefinedDeploymentSchema, {}).success).toBe(false);
  });

  it("a complete config is parsed with the refinement", () => {
    const bad = parseLoadGate(OrgrefinedDeploymentSchema, { mode: "strict", endpoint: "http://x" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["endpoint", "strict mode needs https"],
    ]);
    expect(
      parseLoadGate(OrgrefinedDeploymentSchema, { mode: "strict", endpoint: "https://x" }).success,
    ).toBe(true);
    expect(
      parseLoadGate(OrgrefinedDeploymentSchema, { mode: "loose", endpoint: "http://x" }).success,
    ).toBe(true);
  });

  it("parseDeploymentConfig (CLI) uses the same gate", () => {
    expect(
      parseDeploymentConfig(OrgrefinedDeploymentSchema, { mode: "strict" }, undefined),
    ).toEqual({ ok: true, value: { mode: "strict" } });
    const r = parseDeploymentConfig(
      OrgrefinedDeploymentSchema,
      { mode: "strict", endpoint: "http://x" },
      undefined,
    );
    expect(!r.ok && r.issues.map((i) => i.path)).toEqual(["endpoint"]);
  });
});

describe("a wrapped platform-only field", () => {
  it("fieldLevels reads platformOnly through .optional()", () => {
    expect(Object.fromEntries(fieldLevels(OrgwrappedDeploymentSchema))).toEqual({
      host: "platform",
      region: "override",
    });
  });
});

describe("parseDeploymentConfig (the CLI's deployment config check)", () => {
  it("an empty overridable field counts as configured; a missing platform-only required field does not", () => {
    expect(parseDeploymentConfig(OrglevelsDeploymentSchema, { host: "h" }, undefined)).toEqual({
      ok: true,
      value: { host: "h", limit: 5 },
    });
    // the startup config completes the stored fields, as the kernel merges them
    expect(parseDeploymentConfig(OrglevelsDeploymentSchema, {}, { host: "file" })).toMatchObject({
      ok: true,
    });
    const r = parseDeploymentConfig(OrglevelsDeploymentSchema, { baseUrl: "https://x" }, undefined);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues.map((i) => i.path)).toEqual(["host"]);
  });
});
