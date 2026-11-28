import { type ModelCacheInfo, validateModelCache } from "@capybara-hq/plugin-sdk";

/**
 * The shortest lifetime the long prompt cache tier asks for, in seconds (idle compaction spec
 * §9.2): with `promptCache.longTtl` on, a request asks for the smallest declared option of at
 * least this.
 */
export const LONG_CACHE_MIN_TTL = 1800;

/**
 * The declaration the kernel trusts: undefined when absent or invalid (`validateModelCache`). An
 * invalid declaration makes the model count as not caching; requests never fail because of it.
 */
export function trustedCache(cache: ModelCacheInfo | undefined): ModelCacheInfo | undefined {
  if (cache === undefined) return undefined;
  return validateModelCache(cache) === null ? cache : undefined;
}

/**
 * The `cacheTtl` of one request (a transport option, not model-visible): off → undefined; an
 * absent, invalid or `"none"` declaration → undefined; else the smallest option ≥
 * {@link LONG_CACHE_MIN_TTL}, or undefined when there is none (the model's default applies).
 */
export function selectCacheTtl(
  cache: ModelCacheInfo | undefined,
  longTtl: boolean,
): number | undefined {
  if (!longTtl) return undefined;
  const trusted = trustedCache(cache);
  if (trusted === undefined || trusted.mechanism === "none") return undefined;
  // ttlOptions are ascending (validateModelCache), so the first match is the smallest
  return trusted.ttlOptions.find((ttl) => ttl >= LONG_CACHE_MIN_TTL);
}
