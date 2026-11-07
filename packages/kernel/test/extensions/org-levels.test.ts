import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  fieldLevels,
  jsonSchemaFieldLevels,
  missingOverridable,
  relaxOverridable,
} from "../../src/extensions/org-levels.js";
import { OrglevelsDeploymentSchema } from "../fixtures/plugins/orglevels/index.js";

describe("org field levels (spec A §5.1, §5.4a)", () => {
  it("fieldLevels reads each top-level key's orgAccess; no level is hidden", () => {
    expect(Object.fromEntries(fieldLevels(OrglevelsDeploymentSchema))).toEqual({
      host: "hidden",
      limit: "readonly",
      baseUrl: "override",
      apiKey: "override",
    });
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
    expect(relaxed.safeParse({}).success).toBe(false);
    // a value present must still be valid
    expect(relaxed.safeParse({ host: "h", baseUrl: "not a url" }).success).toBe(false);
  });

  it("relaxOverridable is the identity without overridable keys", () => {
    const s = z.object({ a: z.string() });
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
      b: orgAccessOptional(),
    });
    expect(missingOverridable(optional, {})).toEqual([]);
  });

  it("jsonSchemaFieldLevels reads x-org of top-level properties", () => {
    expect(
      Object.fromEntries(
        jsonSchemaFieldLevels({
          type: "object",
          properties: {
            a: { type: "string" },
            b: { type: "string", "x-org": "readonly" },
            c: { type: "string", "x-org": "override" },
            d: { type: "string", "x-org": "bogus" },
          },
        }),
      ),
    ).toEqual({ a: "hidden", b: "readonly", c: "override", d: "hidden" });
    expect(jsonSchemaFieldLevels(undefined).size).toBe(0);
  });
});

function orgAccessOptional() {
  return z.string().optional().meta({ org: "override" });
}
