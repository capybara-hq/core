import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { ApiError } from "../errors.js";

/**
 * Shared and exclusive sandbox leases (sub-agents spec §10.3): the Redis protocol that lets several
 * holders use one conversation's running sandbox concurrently (shared leases: commands, file reads
 * and writes) while lifecycle changes (create, resume, rebuild, suspend, destroy) stay alone
 * (exclusive leases). Keys, conversation = the sandbox conversation:
 *
 * - `capk:sandbox:<conv>`: the lock key kept from before (rollout, §10.8): an exclusive holder's
 *   token, or `shared` while shared leases exist. An older replica's `SET NX` therefore never gets
 *   in while shared leases live, and its token blocks new shared leases.
 * - `capk:sandbox-users:<conv>`: sorted set of shared lease tokens scored by their expiry (ms, Redis
 *   server clock).
 * - `capk:sandbox-intent:<conv>`: an exclusive waiter's token (writer preference); while it exists
 *   no new shared lease is granted.
 * - `capk:sandbox-holders:<conv>`: hash token → expiry of holders that may have commands running
 *   (the per-holder replacement of the single busy marker `capk:sandbox-busy:<conv>`, still read).
 * - `capk:sandbox-path:<conv>:<sha256hex(path)>`: a short per-path lease around the kernel's own
 *   read-modify-write of one file.
 *
 * Every script purges expired shared leases first, and every key carries a TTL. A holder renews
 * every TTL / 3 (a timer for a lease this process holds) and treats "no successful renewal for
 * 2/3 TTL" as lost: its `signal` aborts with {@link SandboxLockLostError}.
 */

/** Prefix of the lock key `capk:sandbox:<conversationId>`. */
export const SANDBOX_LOCK_PREFIX = "capk:sandbox:";
/** TTL of a lease (ms): renewed every TTL / 3 while held. */
export const SANDBOX_LOCK_TTL_MS = 60_000;
/**
 * Prefix of the single "sandbox in use" marker of kernels before phase C,
 * `capk:sandbox-busy:<conversationId>`: present while such a holder ran commands. Found by an
 * exclusive acquirer, it means that holder crashed and its commands may still run.
 */
export const SANDBOX_BUSY_PREFIX = "capk:sandbox-busy:";
const USERS_PREFIX = "capk:sandbox-users:";
const INTENT_PREFIX = "capk:sandbox-intent:";
const HOLDERS_PREFIX = "capk:sandbox-holders:";
const PATH_PREFIX = "capk:sandbox-path:";
/** TTL of a path lease (ms); renewed while held. */
const PATH_LEASE_TTL_MS = 30_000;

/** The sandbox of this conversation is busy: waited longer than `sandbox.lockWaitSeconds` (409). */
export const sandboxBusy = (): ApiError =>
  new ApiError(
    "sandbox.busy",
    "The sandbox for this conversation is busy with another command; wait for it to finish and try again",
  );

/** A lease was lost while held, or the record changed under it (generation mismatch). */
export class SandboxLockLostError extends Error {
  /** `lock`: the lease was lost (renewal failed or none succeeded in time); `generation`: the record's fence changed. */
  readonly reason: "lock" | "generation";

  constructor(conversationId: string, reason: "lock" | "generation" = "lock") {
    super(
      reason === "lock"
        ? `sandbox lock lost for conversation ${conversationId}`
        : `sandbox state of conversation ${conversationId} changed concurrently (generation mismatch)`,
    );
    this.name = "SandboxLockLostError";
    this.reason = reason;
  }
}

/** Another holder kept writing the same file longer than the path lease wait (model-visible text). */
export class SandboxPathBusyError extends Error {
  constructor() {
    super("another sub-agent is writing this file; try again");
    this.name = "SandboxPathBusyError";
  }
}

export type LeaseKind = "shared" | "exclusive";

/** A lease this process holds. */
export interface SandboxLease {
  readonly kind: LeaseKind;
  readonly token: string;
  readonly conversationId: string;
  /** Aborts with {@link SandboxLockLostError} when the lease is lost. */
  readonly signal: AbortSignal;
  /** Renews once now; false when the lease is lost (the signal then aborts). */
  renew(): Promise<boolean>;
  /** Stops renewing and releases the lease (only this holder's). */
  release(): Promise<void>;
  /** exclusive → shared in one Lua step (same token, same signal); throws if not exclusive. */
  downgrade(): Promise<SandboxLease>;
}

const NOW = `local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;

/** Drops expired shared leases; drops a `shared` lock value no live shared lease backs. */
const PURGE = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local cur = redis.call('GET', KEYS[1])
if cur == 'shared' and redis.call('ZCARD', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[1])
  cur = false
end`;

/** KEYS lock, users, intent; ARGV token, cap, ttl. */
const ACQUIRE_SHARED = `${NOW}
${PURGE}
if cur and cur ~= 'shared' then return 0 end
local it = redis.call('GET', KEYS[3])
if it and it ~= ARGV[1] then return 0 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return 0 end
local ttl = tonumber(ARGV[3])
redis.call('ZADD', KEYS[2], now + ttl, ARGV[1])
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('SET', KEYS[1], 'shared', 'PX', ttl)
return 1`;

/** KEYS lock, users, intent; ARGV token, ttl, setIntent (0/1), intentTtl. */
const ACQUIRE_EXCLUSIVE = `${NOW}
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
const RENEW = `${NOW}
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
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('SET', KEYS[1], 'shared', 'PX', ttl)
return 1`;

/** KEYS lock, users; ARGV token, kind. */
const RELEASE = `${NOW}
if ARGV[2] == 'exclusive' then
  if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
  return 1
end
redis.call('ZREM', KEYS[2], ARGV[1])
${PURGE}
return 1`;

/** KEYS lock, users; ARGV token, ttl. */
const DOWNGRADE = `${NOW}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local ttl = tonumber(ARGV[2])
redis.call('ZADD', KEYS[2], now + ttl, ARGV[1])
redis.call('PEXPIRE', KEYS[2], ttl)
redis.call('SET', KEYS[1], 'shared', 'PX', ttl)
return 1`;

/** KEYS lock, users; returns the live shared count. */
const COUNT = `${NOW}
${PURGE}
return redis.call('ZCARD', KEYS[2])`;

/** KEYS holders; ARGV token, ttl. */
const REGISTER = `${NOW}
local ttl = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], now + ttl)
if redis.call('PTTL', KEYS[1]) < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1`;

/**
 * KEYS lock, users, holders, busy. Removes and returns the holder fields without a live lease
 * (expired fields are dropped without being returned: the in-sandbox time limit ended their
 * commands); claims the legacy busy marker only when no shared lease is live (the caller holds the
 * exclusive lease, so killing everything cannot hit a live sibling). Returns { legacy, tag… }.
 */
const CLAIM = `${NOW}
${PURGE}
local out = {0}
local f = redis.call('HGETALL', KEYS[3])
for i = 1, #f, 2 do
  local tok = f[i]
  if tonumber(f[i + 1]) <= now then
    redis.call('HDEL', KEYS[3], tok)
  elseif tok ~= cur and not redis.call('ZSCORE', KEYS[2], tok) then
    redis.call('HDEL', KEYS[3], tok)
    table.insert(out, tok)
  end
end
if redis.call('ZCARD', KEYS[2]) == 0 and redis.call('DEL', KEYS[4]) == 1 then out[1] = 1 end
return out`;

/** Compare-and-delete / compare-and-expire of a single-valued key. */
const DEL_IF = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const EXPIRE_IF = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("This operation was aborted", "AbortError");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One held lease's state, shared by its exclusive and (after downgrade) shared views. */
interface State {
  kind: LeaseKind;
  readonly token: string;
  readonly conv: string;
  readonly ctl: AbortController;
  lastOk: number;
  stop(): void;
}

export interface SandboxLeasesDeps {
  redis: Redis;
  log: Pick<Logger, "warn">;
  /** Lease TTL (ms), default {@link SANDBOX_LOCK_TTL_MS}. */
  ttlMs?: number;
  /** Poll interval while waiting (ms, jittered up to 2×), default 100. */
  pollMs?: number;
}

/** The lease protocol; no state in process beyond the leases this process holds. */
export class SandboxLeases {
  private readonly redis: Redis;
  private readonly log: Pick<Logger, "warn">;
  private readonly ttlMs: number;
  private readonly pollMs: number;

  constructor(d: SandboxLeasesDeps) {
    this.redis = d.redis;
    this.log = d.log;
    this.ttlMs = d.ttlMs ?? SANDBOX_LOCK_TTL_MS;
    this.pollMs = d.pollMs ?? 100;
  }

  private keys(conv: string): [string, string, string] {
    return [`${SANDBOX_LOCK_PREFIX}${conv}`, `${USERS_PREFIX}${conv}`, `${INTENT_PREFIX}${conv}`];
  }

  private wait(signal: AbortSignal): Promise<void> {
    return sleep(this.pollMs + Math.floor(Math.random() * this.pollMs), signal);
  }

  /**
   * A shared lease (`cap` holders at most), polling until one is free; `sandbox.busy` after
   * `capMs`, the signal's reason when it aborts. Not granted while an exclusive lease, an older
   * replica's lock token or another caller's intent exists.
   */
  async acquireShared(
    conv: string,
    cap: number,
    signal: AbortSignal,
    capMs: number,
  ): Promise<SandboxLease> {
    const token = randomUUID();
    const deadline = Date.now() + capMs;
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      const ok = await this.redis.eval(
        ACQUIRE_SHARED,
        3,
        ...this.keys(conv),
        token,
        cap,
        this.ttlMs,
      );
      if (Number(ok) === 1) return this.hold(conv, token, "shared");
      if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
      await this.wait(signal);
    }
  }

  /**
   * An exclusive lease, polling until no other lease exists; `sandbox.busy` after `capMs` (no cap
   * when omitted), the signal's reason when it aborts. With `intent` the waiter sets the intent
   * (refreshed while it waits) so new shared leases stop being granted; it is cleared on success
   * and when the wait ends otherwise.
   */
  async acquireExclusive(
    conv: string,
    signal: AbortSignal,
    capMs?: number,
    o: { intent?: boolean } = {},
  ): Promise<SandboxLease> {
    const token = randomUUID();
    const deadline = capMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + capMs;
    const keys = this.keys(conv);
    try {
      for (;;) {
        if (signal.aborted) throw abortReason(signal);
        const ok = await this.redis.eval(
          ACQUIRE_EXCLUSIVE,
          3,
          ...keys,
          token,
          this.ttlMs,
          o.intent ? 1 : 0,
          this.pollMs * 4,
        );
        if (Number(ok) === 1) return this.hold(conv, token, "exclusive");
        if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
        await this.wait(signal);
      }
    } catch (e) {
      if (o.intent) {
        await this.redis
          .eval(DEL_IF, 1, keys[2], token)
          .catch((err: unknown) =>
            this.log.warn("cannot clear sandbox intent", { conversationId: conv, err }),
          );
      }
      throw e;
    }
  }

  /** One try at an exclusive lease, without intent (sweeps); null when any lease exists. */
  async tryExclusive(conv: string): Promise<SandboxLease | null> {
    const token = randomUUID();
    const ok = await this.redis.eval(
      ACQUIRE_EXCLUSIVE,
      3,
      ...this.keys(conv),
      token,
      this.ttlMs,
      0,
      0,
    );
    return Number(ok) === 1 ? this.hold(conv, token, "exclusive") : null;
  }

  /** Live shared leases of the conversation. */
  async sharedCount(conv: string): Promise<number> {
    const [lock, users] = this.keys(conv);
    return Number(await this.redis.eval(COUNT, 2, lock, users));
  }

  /** Records a holder that may run commands (before its provider calls); `ttlMs` bounds the record. */
  async registerHolder(conv: string, token: string, ttlMs: number): Promise<void> {
    await this.redis.eval(REGISTER, 1, `${HOLDERS_PREFIX}${conv}`, token, ttlMs);
  }

  /** Deletes a holder record (after its provider calls). */
  async unregisterHolder(conv: string, token: string): Promise<void> {
    await this.redis.hdel(`${HOLDERS_PREFIX}${conv}`, token);
  }

  /**
   * Tags of holders without a live lease, plus whether the legacy single busy marker was present.
   * Atomically claims them (removes the fields) so only one caller kills. The legacy marker is
   * claimed only by a caller that holds the exclusive lease (no shared lease live).
   */
  async claimDeadHolders(conv: string): Promise<{ tags: string[]; legacyMarker: boolean }> {
    const [lock, users] = this.keys(conv);
    const r = (await this.redis.eval(
      CLAIM,
      4,
      lock,
      users,
      `${HOLDERS_PREFIX}${conv}`,
      `${SANDBOX_BUSY_PREFIX}${conv}`,
    )) as [number, ...string[]];
    const [legacy, ...tags] = r;
    return { tags, legacyMarker: Number(legacy) === 1 };
  }

  /**
   * A short lease on one path of the sandbox (the kernel's own read-modify-write of a file); waits
   * up to `capMs`, then throws {@link SandboxPathBusyError}. Renewed while held.
   */
  async pathLease(
    conv: string,
    path: string,
    signal: AbortSignal,
    capMs: number,
  ): Promise<{ release(): Promise<void> }> {
    const key = `${PATH_PREFIX}${conv}:${createHash("sha256").update(path).digest("hex")}`;
    const token = randomUUID();
    const deadline = Date.now() + capMs;
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      if ((await this.redis.set(key, token, "PX", PATH_LEASE_TTL_MS, "NX")) === "OK") break;
      if (Date.now() + this.pollMs > deadline) throw new SandboxPathBusyError();
      await this.wait(signal);
    }
    const timer = setInterval(
      () => {
        this.redis
          .eval(EXPIRE_IF, 1, key, token, PATH_LEASE_TTL_MS)
          .catch((err: unknown) =>
            this.log.warn("sandbox path lease renew failed", { conversationId: conv, err }),
          );
      },
      Math.floor(PATH_LEASE_TTL_MS / 3),
    );
    timer.unref();
    return {
      release: async () => {
        clearInterval(timer);
        await this.redis.eval(DEL_IF, 1, key, token);
      },
    };
  }

  /**
   * Wraps a just-acquired lease: renews every TTL / 3 and remembers the last successful renewal;
   * the lease is lost when a renewal reports it gone or none succeeded for 2/3 TTL (leaving margin
   * so the abort takes effect before the key expires).
   */
  private hold(conv: string, token: string, kind: LeaseKind): SandboxLease {
    const ctl = new AbortController();
    const staleMs = Math.floor((this.ttlMs * 2) / 3);
    let inFlight = false;
    const s: State = {
      kind,
      token,
      conv,
      ctl,
      lastOk: Date.now(),
      stop: () => {
        clearInterval(timer);
        clearInterval(watchdog);
      },
    };
    const stale = () => Date.now() - s.lastOk > staleMs;
    const tick = () => {
      if (stale()) this.lose(s);
      if (ctl.signal.aborted) {
        s.stop();
        return;
      }
      if (inFlight) return;
      inFlight = true;
      void this.renew(s).finally(() => {
        inFlight = false;
      });
    };
    const timer = setInterval(tick, Math.max(1, Math.floor(this.ttlMs / 3)));
    timer.unref();
    // a finer check (at most every 5 s): notices a renewal that hangs
    const watchdog = setInterval(
      () => {
        if (stale()) this.lose(s);
        if (ctl.signal.aborted) s.stop();
      },
      Math.min(5000, Math.max(1, Math.floor(this.ttlMs / 6))),
    );
    watchdog.unref();
    return this.view(s, kind);
  }

  private lose(s: State): void {
    if (s.ctl.signal.aborted) return;
    this.log.warn("sandbox lease lost", { conversationId: s.conv, kind: s.kind });
    s.ctl.abort(new SandboxLockLostError(s.conv));
    s.stop();
  }

  private async renew(s: State): Promise<boolean> {
    if (s.ctl.signal.aborted) return false;
    const [lock, users] = this.keys(s.conv);
    try {
      const ok = Number(await this.redis.eval(RENEW, 2, lock, users, s.token, this.ttlMs, s.kind));
      if (ok === 1) s.lastOk = Date.now();
      else this.lose(s);
    } catch (err) {
      this.log.warn("sandbox lease renew failed", { conversationId: s.conv, err });
    }
    if (Date.now() - s.lastOk > Math.floor((this.ttlMs * 2) / 3)) this.lose(s);
    return !s.ctl.signal.aborted;
  }

  /** A lease view of `s` as `kind`; a view stops working once the lease changes kind. */
  private view(s: State, kind: LeaseKind): SandboxLease {
    const [lock, users] = this.keys(s.conv);
    const current = () => s.kind === kind;
    return {
      kind,
      token: s.token,
      conversationId: s.conv,
      signal: s.ctl.signal,
      renew: () => (current() ? this.renew(s) : Promise.resolve(false)),
      release: async () => {
        if (!current()) return;
        s.stop();
        await this.redis
          .eval(RELEASE, 2, lock, users, s.token, s.kind)
          .catch((err: unknown) =>
            this.log.warn("cannot release sandbox lease", { conversationId: s.conv, err }),
          );
      },
      downgrade: async () => {
        if (!current() || s.kind !== "exclusive") {
          throw new Error("sandbox lease is not exclusive");
        }
        if (s.ctl.signal.aborted) throw abortReason(s.ctl.signal);
        const ok = Number(await this.redis.eval(DOWNGRADE, 2, lock, users, s.token, this.ttlMs));
        if (ok !== 1) {
          this.lose(s);
          throw new SandboxLockLostError(s.conv);
        }
        s.kind = "shared";
        s.lastOk = Date.now();
        return this.view(s, "shared");
      },
    };
  }
}
