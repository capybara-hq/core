/**
 * Shared and exclusive leases on one resource (a reader-writer lease across replicas): up to `cap`
 * shared holders at once, or one exclusive holder alone, with writer preference through an intent
 * key. The Redis layout (the caller names the three keys; no `lock:` prefix is added):
 *
 * - `lock`: the exclusive holder's token, or `shared` while shared leases exist (so a plain
 *   `SET NX` holder of the same key and the shared holders exclude each other);
 * - `users`: sorted set of shared holders' tokens scored by their expiry (ms, Redis server clock);
 * - `intent`: an exclusive waiter's token; while it exists no new shared lease is granted except
 *   to the waiter's own token.
 *
 * Every script purges expired shared leases first, and every key carries a TTL. The scripts are
 * the protocol of {@link LockService.tryShared} / {@link LockService.tryExclusive} and the handle
 * they return (renewal, release, downgrade).
 */

/** The three keys of one shared lease (see the module comment). */
export interface SharedLeaseKeys {
  lock: string;
  users: string;
  intent: string;
}

export type SharedLeaseKind = "shared" | "exclusive";

/**
 * Lua fragments for scripts that read a shared lease atomically with other keys (KEYS[1] the lock
 * key, KEYS[2] the users set): `now` sets `now` (ms, Redis server clock), `purge` (after `now`)
 * drops expired shared leases and a `shared` value no live lease backs, and sets `cur` to the lock
 * key's value (false when absent).
 */
export const SHARED_LEASE_LUA = {
  now: `local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`,
  purge: `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local cur = redis.call('GET', KEYS[1])
if cur == 'shared' and redis.call('ZCARD', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[1])
  cur = false
end`,
} as const;

const { now: NOW, purge: PURGE } = SHARED_LEASE_LUA;

/**
 * Keeps the users set and the `shared` lock value alive for at least `ttl` without shortening a
 * longer TTL another holder set (holders may use different TTLs).
 */
const KEEP_SHARED = `
if redis.call('PTTL', KEYS[2]) < ttl then redis.call('PEXPIRE', KEYS[2], ttl) end
local lt = redis.call('PTTL', KEYS[1])
if redis.call('GET', KEYS[1]) ~= 'shared' or lt < ttl then
  redis.call('SET', KEYS[1], 'shared', 'PX', math.max(ttl, lt))
end`;

/** KEYS lock, users, intent; ARGV token, cap, ttl. */
export const ACQUIRE_SHARED = `${NOW}
${PURGE}
if cur and cur ~= 'shared' then return 0 end
local it = redis.call('GET', KEYS[3])
if it and it ~= ARGV[1] then return 0 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return 0 end
local ttl = tonumber(ARGV[3])
redis.call('ZADD', KEYS[2], now + ttl, ARGV[1])
${KEEP_SHARED}
return 1`;

/** KEYS lock, users, intent; ARGV token, ttl, setIntent (0/1), intentTtl. */
export const ACQUIRE_EXCLUSIVE = `${NOW}
${PURGE}
if cur or redis.call('ZCARD', KEYS[2]) > 0 then
  if ARGV[3] == '1' then
    local it = redis.call('GET', KEYS[3])
    if (not it) or it == ARGV[1] then
      redis.call('SET', KEYS[3], ARGV[1], 'PX', tonumber(ARGV[4]))
    end
  end
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
return 1`;

/** KEYS lock, users; ARGV token, ttl, kind. Shared: lost when the member is gone or the lock holds a token. */
export const RENEW_SHARED_LEASE = `${NOW}
local ttl = tonumber(ARGV[2])
if ARGV[3] == 'exclusive' then
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    redis.call('PEXPIRE', KEYS[1], ttl)
    return 1
  end
  return 0
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if not redis.call('ZSCORE', KEYS[2], ARGV[1]) then return 0 end
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= 'shared' then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 0
end
redis.call('ZADD', KEYS[2], 'XX', now + ttl, ARGV[1])
${KEEP_SHARED}
return 1`;

/** KEYS lock, users; ARGV token, kind. */
export const RELEASE_SHARED_LEASE = `${NOW}
if ARGV[2] == 'exclusive' then
  if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
  return 1
end
redis.call('ZREM', KEYS[2], ARGV[1])
${PURGE}
return 1`;

/** KEYS lock, users; ARGV token, ttl. */
export const DOWNGRADE_SHARED_LEASE = `${NOW}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local ttl = tonumber(ARGV[2])
redis.call('ZADD', KEYS[2], now + ttl, ARGV[1])
${KEEP_SHARED}
return 1`;

/** KEYS lock, users; returns the live shared count. */
export const COUNT_SHARED_LEASES = `${NOW}
${PURGE}
return redis.call('ZCARD', KEYS[2])`;
