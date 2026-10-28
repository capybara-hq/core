// Ported from octok-platform libs/common/src/cache/cacheable.decorator.ts (owner-approved, 2026-10-28).
// Adapted: an injectable service over the shared Redis connection that fails open.
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER, REDIS } from "../tokens.js";

/** Stored instead of a value when a method returned null and `cacheNull` is set. */
export const CACHE_NULL_SENTINEL = "__CACHE_NULL__";

const prefixed = (key: string) => (key.startsWith("cache:") ? key : `cache:${key}`);

/**
 * Redis access of `@Cacheable` / `@CacheEvict`. Every operation fails open: a Redis error is
 * logged at warn and behaves like a miss (read) or a no-op (write, delete); it never throws.
 */
@Injectable()
export class CacheService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /** The raw stored string under `cache:<key>`, or undefined on a miss or a Redis error. */
  async get(key: string): Promise<string | undefined> {
    const cacheKey = prefixed(key);
    try {
      return (await this.redis.get(cacheKey)) ?? undefined;
    } catch (err) {
      this.log.warn("cache read failed, calling through", { cacheKey, err });
      return undefined;
    }
  }

  /** Stores `value` under `cache:<key>` with a TTL in seconds. */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const cacheKey = prefixed(key);
    try {
      await this.redis.set(cacheKey, value, "EX", ttlSeconds);
    } catch (err) {
      this.log.warn("cache write failed, result not cached", { cacheKey, err });
    }
  }

  /** Like `set`, serializing `value` as JSON; an unserializable value (bigint, cycle) is not cached. */
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    let json: string;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      this.log.warn("cache value not serializable, result not cached", {
        cacheKey: prefixed(key),
        err,
      });
      return;
    }
    await this.set(key, json, ttlSeconds);
  }

  /** Deletes `cache:<key>`. */
  async del(key: string): Promise<void> {
    const cacheKey = prefixed(key);
    try {
      await this.redis.del(cacheKey);
    } catch (err) {
      this.log.warn("cache eviction failed", { cacheKey, err });
    }
  }
}
