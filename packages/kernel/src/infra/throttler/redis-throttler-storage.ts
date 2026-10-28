// Ported from octok-platform libs/common/src/throttler/redis-throttler-storage.service.ts
// (owner-approved, 2026-10-28). Adapted to the kernel: pino logger, one counter key, and
// "rejected attempts do not count" (the login limiter's rule, R25).
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { Redis } from "ioredis";
import type { KernelLogger } from "../../log.js";

// `@nestjs/throttler` does not export ThrottlerStorageRecord; declared locally to its shape.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * One atomic EVAL: when the counter already reached the limit the attempt is rejected and
 * NOT counted (a rejected attempt must not push the count further, so the window ends on
 * schedule); otherwise the counter is incremented and always carries a TTL. Returns
 * `{hits, pttl, blocked}`. `now` is not needed: no TIME command, no clock in the script.
 */
const INCREMENT_LUA = `
local key = KEYS[1]
local ttlMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local hits = tonumber(redis.call('GET', key) or '0')
local blocked = 0
if hits >= limit then
  blocked = 1
else
  hits = redis.call('INCR', key)
end
local pttl = redis.call('PTTL', key)
if pttl < 0 then
  redis.call('PEXPIRE', key, ttlMs)
  pttl = ttlMs
end
return {hits, pttl, blocked}
`;

/** Success path: the counter is deleted (`reset`) or lowered by one, never below zero (`refund`). */
const REFUND_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  if redis.call('DECR', KEYS[1]) <= 0 then
    redis.call('DEL', KEYS[1])
  end
end
return 0
`;

const NOT_BLOCKED: ThrottlerStorageRecord = {
  totalHits: 0,
  timeToExpire: 0,
  isBlocked: false,
  timeToBlockExpire: 0,
};

/** The Redis key of a counter. The `{key}` hash tag keeps it in one Redis Cluster slot. */
export const throttlerRedisKey = (key: string, throttlerName: string) =>
  `throttler:{${key}}:${throttlerName}`;

/**
 * The `@nestjs/throttler` storage on the shared Redis connection: every replica counts into the
 * same keys (the default in-memory storage would give each replica its own quota). Fail-open: a
 * Redis error lets the request through and logs a warning, so a Redis blip never turns every
 * throttled route into a 5xx (availability over limit precision).
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(
    private readonly redis: Redis,
    private readonly log: KernelLogger,
  ) {}

  /** `ttl` is in milliseconds (the throttler convention); `blockDuration` is unused. */
  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    try {
      const [hits, pttl, blocked] = (await this.redis.eval(
        INCREMENT_LUA,
        1,
        throttlerRedisKey(key, throttlerName),
        ttl,
        limit,
      )) as [number, number, number];
      // seconds, at least 1 and at most the window: the Retry-After value
      const timeToExpire = Math.min(Math.max(Math.ceil(pttl / 1000), 1), Math.ceil(ttl / 1000));
      return {
        totalHits: hits,
        timeToExpire,
        isBlocked: blocked === 1,
        timeToBlockExpire: blocked === 1 ? timeToExpire : 0,
      };
    } catch (err) {
      this.log.warn("throttler storage unavailable, request allowed (fail-open)", {
        throttler: throttlerName,
        err,
      });
      return NOT_BLOCKED;
    }
  }

  /** Deletes the counter (a successful attempt clears it). Best effort. */
  async reset(key: string, throttlerName: string): Promise<void> {
    try {
      await this.redis.del(throttlerRedisKey(key, throttlerName));
    } catch (err) {
      this.log.warn("throttler reset failed", { throttler: throttlerName, err });
    }
  }

  /** Gives one attempt back (a successful attempt does not use the budget). Best effort. */
  async refund(key: string, throttlerName: string): Promise<void> {
    try {
      await this.redis.eval(REFUND_LUA, 1, throttlerRedisKey(key, throttlerName));
    } catch (err) {
      this.log.warn("throttler refund failed", { throttler: throttlerName, err });
    }
  }
}
