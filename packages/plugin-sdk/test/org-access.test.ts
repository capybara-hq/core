import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configJsonSchema, isSecret, orgAccess, orgAccessOf, secret } from "../src/index.js";

describe("orgAccess", () => {
  it("reads back the level it was given", () => {
    expect(orgAccessOf(orgAccess(z.string(), "override"))).toBe("override");
    expect(orgAccessOf(orgAccess(z.string(), "readonly"))).toBe("readonly");
  });

  it("is undefined without a level", () => {
    expect(orgAccessOf(z.string())).toBeUndefined();
  });

  it("merges with other meta in either order", () => {
    const a = orgAccess(secret(z.string()), "override");
    expect(isSecret(a)).toBe(true);
    expect(orgAccessOf(a)).toBe("override");
    const b = secret(orgAccess(z.string(), "override"));
    expect(isSecret(b)).toBe(true);
    expect(orgAccessOf(b)).toBe("override");
  });

  it("sees through optional / default / nullable / prefault / catch / readonly wrappers", () => {
    const base = () => orgAccess(z.string(), "override");
    expect(orgAccessOf(base().optional())).toBe("override");
    expect(orgAccessOf(base().default("x"))).toBe("override");
    expect(orgAccessOf(base().nullable())).toBe("override");
    expect(orgAccessOf(base().prefault("x"))).toBe("override");
    expect(orgAccessOf(base().catch("x"))).toBe("override");
    expect(orgAccessOf(base().readonly())).toBe("override");
    expect(orgAccessOf(base().nullable().optional().default(null))).toBe("override");
    expect(orgAccessOf(z.string().optional())).toBeUndefined();
  });

  it("matches the x-org the JSON Schema publishes for a wrapped field", () => {
    const field = orgAccess(z.string(), "readonly").default("x");
    const js = configJsonSchema(z.object({ field })) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(js.properties.field?.["x-org"]).toBe("readonly");
    expect(orgAccessOf(field)).toBe("readonly");
  });

  it("the outermost level wins", () => {
    expect(orgAccessOf(orgAccess(orgAccess(z.string(), "override").optional(), "readonly"))).toBe(
      "readonly",
    );
  });
});
