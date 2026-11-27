import { describe, expect, it } from "vitest";
import {
  type ModelCacheInfo,
  type ModelUsage,
  validateCacheWriteByTtl,
  validateModelCache,
} from "../src/index.js";

const NONE: ModelCacheInfo = {
  mechanism: "none",
  ttlOptions: [],
  ttlIsMinimum: false,
  refreshOnHit: false,
  ttlClock: "unknown",
  guaranteed: false,
};

const ANTHROPIC: ModelCacheInfo = {
  mechanism: "explicit",
  ttlOptions: [300, 3600],
  defaultTtl: 300,
  ttlIsMinimum: false,
  refreshOnHit: true,
  ttlClock: "request_start",
  guaranteed: true,
};

const OPENAI: ModelCacheInfo = {
  mechanism: "implicit",
  ttlOptions: [1800, 43200],
  defaultTtl: 1800,
  ttlIsMinimum: true,
  refreshOnHit: true,
  ttlClock: "unknown",
  guaranteed: true,
};

const DEEPSEEK: ModelCacheInfo = {
  mechanism: "implicit",
  ttlOptions: [],
  ttlIsMinimum: false,
  refreshOnHit: false,
  ttlClock: "unknown",
  guaranteed: false,
};

describe("validateModelCache", () => {
  it("accepts an absent declaration and the vendors' declarations", () => {
    expect(validateModelCache(undefined)).toBeNull();
    expect(validateModelCache(NONE)).toBeNull();
    expect(validateModelCache(ANTHROPIC)).toBeNull();
    expect(validateModelCache(OPENAI)).toBeNull();
    expect(validateModelCache(DEEPSEEK)).toBeNull();
  });

  it.each([0, -300, 1.5])("rejects the TTL %s", (ttl) => {
    expect(validateModelCache({ ...ANTHROPIC, ttlOptions: [ttl, 3600] })).toMatch(/ttlOptions/);
    expect(validateModelCache({ ...DEEPSEEK, defaultTtl: ttl })).toMatch(/defaultTtl/);
  });

  it("rejects options that are not ascending or not unique", () => {
    expect(validateModelCache({ ...ANTHROPIC, ttlOptions: [3600, 300] })).toMatch(/ttlOptions/);
    expect(validateModelCache({ ...ANTHROPIC, ttlOptions: [300, 300] })).toMatch(/ttlOptions/);
  });

  it("rejects a defaultTtl outside the options", () => {
    expect(validateModelCache({ ...ANTHROPIC, defaultTtl: 600 })).toMatch(/defaultTtl/);
  });

  it("rejects mechanism none with options or a guarantee", () => {
    expect(validateModelCache({ ...NONE, ttlOptions: [300] })).toMatch(/mechanism/);
    expect(validateModelCache({ ...NONE, guaranteed: true })).toMatch(/guaranteed/);
  });

  it("rejects a guarantee with no known lifetime", () => {
    expect(validateModelCache({ ...DEEPSEEK, guaranteed: true })).toMatch(/guaranteed/);
  });

  it("rejects minTokens 0", () => {
    expect(validateModelCache({ ...ANTHROPIC, minTokens: 0 })).toMatch(/minTokens/);
  });
});

describe("validateCacheWriteByTtl", () => {
  const usage = (extra: Partial<ModelUsage>): ModelUsage => ({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 100,
    ...extra,
  });

  it("accepts an absent breakdown and one that sums to cacheWriteTokens", () => {
    expect(validateCacheWriteByTtl(usage({}))).toBeNull();
    expect(
      validateCacheWriteByTtl(
        usage({
          cacheWriteByTtl: [
            { ttl: 300, tokens: 40 },
            { ttl: 3600, tokens: 60 },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("rejects a breakdown that does not sum to cacheWriteTokens", () => {
    expect(
      validateCacheWriteByTtl(
        usage({
          cacheWriteByTtl: [
            { ttl: 300, tokens: 39 },
            { ttl: 3600, tokens: 60 },
          ],
        }),
      ),
    ).toMatch(/cacheWriteByTtl/);
  });

  it("rejects a duplicate ttl", () => {
    expect(
      validateCacheWriteByTtl(
        usage({
          cacheWriteByTtl: [
            { ttl: 300, tokens: 40 },
            { ttl: 300, tokens: 60 },
          ],
        }),
      ),
    ).toMatch(/cacheWriteByTtl/);
  });

  it.each([-1, 1.5])("rejects tokens %s", (tokens) => {
    expect(
      validateCacheWriteByTtl(
        usage({
          cacheWriteTokens: 60 + tokens,
          cacheWriteByTtl: [
            { ttl: 300, tokens },
            { ttl: 3600, tokens: 60 },
          ],
        }),
      ),
    ).toMatch(/tokens/);
  });
});
