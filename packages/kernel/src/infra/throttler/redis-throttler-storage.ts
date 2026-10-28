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

/**
 * All-or-nothing reservation across KEYS (one hash tag): ARGV[1] is the window in ms, ARGV[i + 1]
 * the limit of KEYS[i]. Any key at its limit rejects the attempt and NOTHING is incremented;
 * otherwise every key is incremented and carries a TTL. Returns `{1}` or `{0, retryPttl}` (the
 * largest remaining TTL among the keys at their limit).
 */
const RESERVE_LUA = `
local retry = -1
for i, key in ipairs(KEYS) do
  local n = tonumber(redis.call('GET', key) or '0')
  if n >= tonumber(ARGV[i + 1]) then
    local pttl = redis.call('PTTL', key)
    if pttl > retry then retry = pttl end
    if retry < 1 then retry = 1 end
  end
end
if retry > 0 then
  return {0, retry}
end
for i, key in ipairs(KEYS) do
  local n = redis.call('INCR', key)
  if n == 1 or redis.call('PTTL', key) < 0 then
    redis.call('PEXPIRE', key, ARGV[1])
  end
end
return {1}
`;

/**
 * Success: the first ARGV[1] keys are deleted, the rest lose one count (deleted at zero, never
 * created).
 */
const SUCCEEDED_LUA = `
local nClear = tonumber(ARGV[1])
for i = 1, nClear do
  redis.call('DEL', KEYS[i])
end
for i = nClear + 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    if redis.call('DECR', KEYS[i]) <= 0 then
      redis.call('DEL', KEYS[i])
    end
  end
end
return 0
`;

export type ReserveResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

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

  /**
   * Reserves one attempt on every key (which must share one hash tag), all or nothing. Unlike
   * `increment` it does NOT swallow Redis errors: the caller fails closed.
   */
  async reserve(keys: string[], limits: number[], ttlMs: number): Promise<ReserveResult> {
    const out = (await this.redis.eval(
      RESERVE_LUA,
      keys.length,
      ...keys,
      ttlMs,
      ...limits,
    )) as number[];
    if (out[0] === 1) return { allowed: true };
    const window = Math.ceil(ttlMs / 1000);
    return {
      allowed: false,
      retryAfterSeconds: Math.min(Math.max(Math.ceil((out[1] ?? ttlMs) / 1000), 1), window),
    };
  }

  /** A successful attempt: deletes the `clear` counters and refunds one on the `refund` ones. Fails closed. */
  async succeeded(clear: string[], refund: string[]): Promise<void> {
    await this.redis.eval(
      SUCCEEDED_LUA,
      clear.length + refund.length,
      ...clear,
      ...refund,
      clear.length,
    );
  }
}
