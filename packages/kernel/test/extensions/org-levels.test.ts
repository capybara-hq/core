import { configJsonSchema, platformOnly, secret } from "@capybara-hq/plugin-sdk";
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

  // the static form (an unloaded module's JSON Schema) and the loaded schema agree on every level
  it.each([
    [
      "platformOnly(x).optional()",
      z.object({ a: platformOnly(z.string()).optional(), b: z.string() }),
    ],
    [
      "platformOnly(x).default()",
      z.object({ a: platformOnly(z.string()).default("d"), b: z.string() }),
    ],
    ["secret(platformOnly(x))", z.object({ a: secret(platformOnly(z.string())), b: z.string() })],
    [
      "platformOnly(x.default())",
      z.object({ a: platformOnly(z.string().default("d")), b: z.number() }),
    ],
    ["a root platformOnly", platformOnly(z.object({ a: z.string(), b: secret(z.string()) }))],
  ])("fieldLevels equals jsonSchemaFieldLevels(configJsonSchema(s)) for %s", (_name, s) => {
    const loaded = Object.fromEntries(fieldLevels(s));
    expect(Object.fromEntries(jsonSchemaFieldLevels(configJsonSchema(s)))).toEqual(loaded);
    expect(loaded.a).toBe("platform");
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

describe("a platformOnly mark below a top-level key fails closed (hand-made package)", () => {
  // the SDK refuses such a mark; zod `.meta` sets it anyway, as a hand-made package could
  const nested = z.object({
    conn: z.object({ url: z.string(), key: platformOnly(z.string()) }),
    list: z.array(z.object({ token: platformOnly(z.string()).optional() })).optional(),
    region: z.string(),
  });

  it("fieldLevels: the whole top-level key is platform", () => {
    expect(Object.fromEntries(fieldLevels(nested))).toEqual({
      conn: "platform",
      list: "platform",
      region: "override",
    });
  });

  it("jsonSchemaFieldLevels: the same, also through a local $ref", () => {
    expect(
      Object.fromEntries(
        jsonSchemaFieldLevels({
          type: "object",
          $defs: { Secret: { type: "string", "x-platform-only": true } },
          properties: {
            conn: {
              type: "object",
              properties: {
                url: { type: "string" },
                key: { type: "string", "x-platform-only": true },
              },
            },
            list: { type: "array", items: { $ref: "#/$defs/Secret" } },
            region: { type: "string" },
          },
        }),
      ),
    ).toEqual({ conn: "platform", list: "platform", region: "override" });
  });

  it("a mark inside z.lazy (also a recursive one) counts, in both forms", () => {
    const s = z.object({
      conn: z.lazy(() => z.object({ key: platformOnly(z.string()) })),
      region: z.string(),
    });
    expect(Object.fromEntries(fieldLevels(s))).toEqual({ conn: "platform", region: "override" });
    expect(Object.fromEntries(jsonSchemaFieldLevels(configJsonSchema(s)))).toEqual({
      conn: "platform",
      region: "override",
    });
    type Node = { child?: Node | undefined };
    const tree: z.ZodType<Node> = z.lazy(() => z.object({ child: tree.optional() }));
    expect(Object.fromEntries(fieldLevels(z.object({ tree, region: z.string() })))).toEqual({
      tree: "override",
      region: "override",
    });
  });

  it("the loaded and the static form agree", () => {
    expect(Object.fromEntries(jsonSchemaFieldLevels(configJsonSchema(nested)))).toEqual(
      Object.fromEntries(fieldLevels(nested)),
    );
  });
});

describe("a pipe or transform deployment root", () => {
  const transformed = z
    .object({ host: platformOnly(z.string()), baseUrl: z.string().url() })
    .transform((v) => ({ ...v, normalized: true }));
  const piped = z
    .object({ host: platformOnly(z.string()), baseUrl: z.string().url() })
    .pipe(z.object({ host: z.string(), baseUrl: z.string() }));

  it.each([
    ["transform", transformed],
    ["pipe", piped],
  ])("fieldLevels sees the input object of a %s root, as its JSON Schema does", (_n, s) => {
    const loaded = Object.fromEntries(fieldLevels(s));
    expect(loaded).toEqual({ host: "platform", baseUrl: "override" });
    expect(Object.fromEntries(jsonSchemaFieldLevels(configJsonSchema(s)))).toEqual(loaded);
  });

  it("the load gate relaxes the input object and keeps the transform", () => {
    expect(missingOverridable(transformed, { host: "h" })).toEqual(["baseUrl"]);
    expect(parseLoadGate(transformed, { host: "h" })).toEqual({
      success: true,
      data: { host: "h", normalized: true },
    });
    expect(parseLoadGate(transformed, {}).success).toBe(false);
  });
});
