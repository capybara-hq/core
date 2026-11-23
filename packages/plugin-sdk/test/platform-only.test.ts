import { describe, expect, it } from "vitest";
import { z } from "zod";
import { configJsonSchema, isPlatformOnly, isSecret, platformOnly, secret } from "../src/index.js";

describe("platformOnly", () => {
  it("marks a schema as platform-only", () => {
    expect(isPlatformOnly(platformOnly(z.string()))).toBe(true);
  });

  it("is false without the mark", () => {
    expect(isPlatformOnly(z.string())).toBe(false);
    expect(isPlatformOnly(z.string().optional())).toBe(false);
  });

  it("merges with other meta in either order", () => {
    const a = secret(platformOnly(z.string()));
    expect(isSecret(a)).toBe(true);
    expect(isPlatformOnly(a)).toBe(true);
    const b = platformOnly(secret(z.string()));
    expect(isSecret(b)).toBe(true);
    expect(isPlatformOnly(b)).toBe(true);
  });

  it("sees through optional / default / nullable / prefault / catch / readonly wrappers", () => {
    const base = () => platformOnly(z.string());
    expect(isPlatformOnly(base().optional().default("a"))).toBe(true);
    expect(isPlatformOnly(base().nullable())).toBe(true);
    expect(isPlatformOnly(base().prefault("x"))).toBe(true);
    expect(isPlatformOnly(base().catch("x"))).toBe(true);
    expect(isPlatformOnly(base().readonly())).toBe(true);
    expect(isPlatformOnly(base().nullable().optional().default(null))).toBe(true);
  });

  it("matches the x-platform-only the JSON Schema publishes for a wrapped field", () => {
    const field = platformOnly(z.string()).default("x");
    const js = configJsonSchema(z.object({ field })) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(js.properties.field?.["x-platform-only"]).toBe(true);
    expect(isPlatformOnly(field)).toBe(true);
  });
});
