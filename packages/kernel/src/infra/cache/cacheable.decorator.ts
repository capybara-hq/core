// Ported from octok-platform libs/common/src/cache/cacheable.decorator.ts (owner-approved, 2026-10-28).
// Adapted: the CacheService comes from the `cacheService` property, as `@Transactional` reads
// `txHost` and `@WithLock` reads `lockService`; Redis errors fail open (see CacheService).
import { generateKey } from "../lock/key-template.js";
import { CACHE_NULL_SENTINEL, type CacheService } from "./cache.service.js";

interface WithCacheService {
  cacheService?: CacheService;
}

function serviceOf(self: WithCacheService, decorator: string): CacheService {
  if (!self.cacheService) {
    throw new Error(
      `${decorator}() needs the class to inject \`CacheService\` as \`cacheService\` ` +
        "(`@Inject(CacheService) readonly cacheService: CacheService`).",
    );
  }
  return self.cacheService;
}

export interface CacheableOptions {
  /**
   * Cache key; `cache:` is prepended unless present. Placeholders expand from the method
   * arguments: `#{0}`, `#{1.book.title}`, `#{user.id}` (= `#{0.user.id}`).
   */
  key: string;
  /** Lifetime in seconds (default 300). */
  ttl?: number;
  /** Also cache a null / undefined result, as a sentinel (default false). */
  cacheNull?: boolean;
}

/**
 * Method decorator: caches the JSON-serializable result in Redis (like Spring's `@Cacheable`).
 * A hit returns the parsed value without calling the method; Redis errors call the method.
 * The class must inject `@Inject(CacheService) readonly cacheService: CacheService`.
 */
export function Cacheable(options: CacheableOptions) {
  return (_target: object, _key: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = async function (this: WithCacheService, ...args: unknown[]) {
      const cache = serviceOf(this, "@Cacheable");
      const key = generateKey(options.key, args);
      const cached = await cache.get(key);
      if (cached === CACHE_NULL_SENTINEL && options.cacheNull) return null;
      if (cached !== undefined && cached !== CACHE_NULL_SENTINEL) {
        try {
          return JSON.parse(cached);
        } catch {
          // An unreadable entry is a miss; it is overwritten below.
        }
      }
      const result = await original.apply(this, args);
      const ttl = options.ttl ?? 300;
      if (result == null) {
        if (options.cacheNull) await cache.set(key, CACHE_NULL_SENTINEL, ttl);
      } else {
        await cache.set(key, JSON.stringify(result), ttl);
      }
      return result;
    };
    return descriptor;
  };
}

export interface CacheEvictOptions {
  /** One key to evict (same placeholders as `@Cacheable`). */
  key?: string;
  /** Several keys; `#{result}` / `#{result.id}` read the method's return value. */
  keys?: string[];
}

/**
 * Method decorator: evicts cache keys after the method succeeded (nothing is evicted when it
 * throws). The class must inject `@Inject(CacheService) readonly cacheService: CacheService`.
 */
export function CacheEvict(options: CacheEvictOptions) {
  return (_target: object, _key: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = async function (this: WithCacheService, ...args: unknown[]) {
      const cache = serviceOf(this, "@CacheEvict");
      const result = await original.apply(this, args);
      const patterns = options.keys ?? (options.key ? [options.key] : []);
      for (const pattern of patterns) await cache.del(generateKey(pattern, args, { result }));
      return result;
    };
    return descriptor;
  };
}
