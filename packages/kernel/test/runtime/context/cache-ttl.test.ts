import type { ModelCacheInfo } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  LONG_CACHE_MIN_TTL,
  selectCacheTtl,
  trustedCache,
} from "../../../src/runtime/context/cache-ttl.js";

/**
 * The prompt cache tier per request (idle compaction spec §9.2): `promptCache.longTtl` off sends
 * no `cacheTtl`; on, the smallest declared option of at least 30 min, if any. A declaration that
 * fails `validateModelCache` is not trusted: the model is treated as not caching.
 */

const base = {
  ttlIsMinimum: false,
  refreshOnHit: true,
  ttlClock: "request_start",
  guaranteed: true,
} as const;
const anthropic: ModelCacheInfo = {
  ...base,
  mechanism: "explicit",
  ttlOptions: [300, 3600],
  defaultTtl: 300,
  minTokens: 1024,
};
const openai: ModelCacheInfo = {
  ...base,
  mechanism: "implicit",
  ttlOptions: [1800, 43200],
  defaultTtl: 1800,
  ttlIsMinimum: true,
};
const bailian: ModelCacheInfo = {
  ...base,
  mechanism: "explicit",
  ttlOptions: [300],
  defaultTtl: 300,
};
const none: ModelCacheInfo = {
  ...base,
  mechanism: "none",
  ttlOptions: [],
  guaranteed: false,
};
const invalid: ModelCacheInfo = { ...anthropic, defaultTtl: 600 };

describe("selectCacheTtl", () => {
  it("the long tier floor is 30 minutes", () => {
    expect(LONG_CACHE_MIN_TTL).toBe(1800);
  });

  it("sends nothing while promptCache.longTtl is off", () => {
    expect(selectCacheTtl(anthropic, false)).toBeUndefined();
    expect(selectCacheTtl(openai, false)).toBeUndefined();
  });

  it("picks the smallest option of at least 1800 s when on", () => {
    expect(selectCacheTtl(anthropic, true)).toBe(3600);
    expect(selectCacheTtl(openai, true)).toBe(1800);
  });

  it("sends nothing when no option reaches 1800 s", () => {
    expect(selectCacheTtl(bailian, true)).toBeUndefined();
  });

  it("sends nothing for a model without caching", () => {
    expect(selectCacheTtl(undefined, true)).toBeUndefined();
    expect(selectCacheTtl(none, true)).toBeUndefined();
  });

  it("an invalid declaration is treated as not caching", () => {
    expect(selectCacheTtl(invalid, true)).toBeUndefined();
  });
});

describe("trustedCache", () => {
  it("passes a valid declaration through and drops an absent or invalid one", () => {
    expect(trustedCache(anthropic)).toBe(anthropic);
    expect(trustedCache(none)).toBe(none);
    expect(trustedCache(undefined)).toBeUndefined();
    expect(trustedCache(invalid)).toBeUndefined();
  });
});
