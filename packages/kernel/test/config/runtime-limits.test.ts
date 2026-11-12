import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { runDeadline, tightestLimit } from "../../src/runtime/limits.js";

const base = {
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
};

describe("run limits", () => {
  it("runtime.maxSteps and runtime.maxRunSeconds default to 0: no limit", () => {
    const cfg = KernelConfigSchema.parse(base);
    expect(cfg.runtime.maxSteps).toBe(0);
    expect(cfg.runtime.maxRunSeconds).toBe(0);
  });

  it("accepts 0 and positive values, rejects negative and fractional ones", () => {
    const parse = (runtime: object) => KernelConfigSchema.safeParse({ ...base, runtime });
    expect(parse({ maxSteps: 0, maxRunSeconds: 0 }).success).toBe(true);
    expect(parse({ maxSteps: 50, maxRunSeconds: 900 }).success).toBe(true);
    expect(parse({ maxSteps: -1 }).success).toBe(false);
    expect(parse({ maxRunSeconds: -1 }).success).toBe(false);
    expect(parse({ maxSteps: 1.5 }).success).toBe(false);
  });

  it("tightestLimit ignores absent and 0 limits", () => {
    expect(tightestLimit()).toBeUndefined();
    expect(tightestLimit(0)).toBeUndefined();
    expect(tightestLimit(undefined, 0)).toBeUndefined();
    expect(tightestLimit(50)).toBe(50);
    expect(tightestLimit(10, 0)).toBe(10);
    expect(tightestLimit(0, 10)).toBe(10);
    expect(tightestLimit(30, 10)).toBe(10);
    expect(tightestLimit(undefined, 12)).toBe(12);
  });

  it("runDeadline: none without a duration limit, start + seconds otherwise", () => {
    expect(runDeadline(1_000, 0)).toBeUndefined();
    expect(runDeadline(1_000, 900)).toBe(1_000 + 900_000);
  });
});
