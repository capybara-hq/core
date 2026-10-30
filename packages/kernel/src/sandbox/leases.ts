import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../errors.js";
import {
  type LeaseHandle,
  LockService,
  type SharedLeaseHandle,
} from "../infra/lock/lock.service.js";
import {
  redisClockScript,
  type SharedLeaseKeys,
  sharedLeaseReadScript,
} from "../infra/lock/shared-lease.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";

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
 * The first three keys are a {@link LockService} shared lease (`tryShared` / `tryExclusive`,
 * infra/lock/shared-lease.ts); the holder records and the path leases are this file's. Every key
 * carries a TTL. A holder renews every TTL / 3 (LockService's watchdog) and loses the lease at
 * the renewal deadline (send time of the last successful renewal + 2/3 TTL): its `signal` aborts
 * with {@link SandboxLockLostError}.
 */

/** Prefix of the lock key `capk:sandbox:<conversationId>`. */
export const SANDBOX_LOCK_PREFIX = "capk:sandbox:";
/** TTL of a lease (ms): renewed every TTL / 3 while held. */
export const SANDBOX_LOCK_TTL_MS = 60_000;
/**
 * Prefix of the single "sandbox in use" marker of kernels before phase C,
 * `capk:sandbox-busy:<conversationId>`: present while such a holder ran commands. Found by an
 * exclusive acquirer, it means that holder crashed and its commands may still run.
 *
 * Holders of this kernel write it too, with the value {@link BUSY_V2}, while any holder record
 * exists (spec §10.8): this kernel ignores that value, and a replica from before phase C that
 * takes the lock after a new holder crashed sees a marker and kills everything, which is safe
 * because it only gets the lock when no shared lease is live.
 */
export const SANDBOX_BUSY_PREFIX = "capk:sandbox-busy:";
/** Value of the busy marker written by holders of this kernel (ignored by it). */
export const BUSY_V2 = "v2";
const USERS_PREFIX = "capk:sandbox-users:";
const INTENT_PREFIX = "capk:sandbox-intent:";
const HOLDERS_PREFIX = "capk:sandbox-holders:";
const PATH_PREFIX = "capk:sandbox-path:";
/** TTL of a path lease (ms); renewed while held. */
const PATH_LEASE_TTL_MS = 30_000;
/** Shortest life of an exclusive waiter's intent (ms): outlasts event-loop lag between polls. */
const INTENT_TTL_FLOOR_MS = 2000;

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

/**
 * KEYS holders, busy; ARGV token, ttl. Also writes the busy marker as v2 (kept for at least `ttl`)
 * unless an older kernel's holder owns it.
 */
const REGISTER = redisClockScript(`local ttl = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], now + ttl)
if redis.call('PTTL', KEYS[1]) < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
local b = redis.call('GET', KEYS[2])
if (not b) or (b == '${BUSY_V2}' and redis.call('PTTL', KEYS[2]) < ttl) then
  redis.call('SET', KEYS[2], '${BUSY_V2}', 'PX', ttl)
end
return 1`);

/** Deletes the v2 busy marker (key `busy`) once no holder record (hash `holders`) is left. */
const dropV2 = (holders: string, busy: string) => `
if redis.call('HLEN', ${holders}) == 0 and redis.call('GET', ${busy}) == '${BUSY_V2}' then
  redis.call('DEL', ${busy})
end`;

/** KEYS holders, busy; ARGV token. */
const UNREGISTER = `
redis.call('HDEL', KEYS[1], ARGV[1])
${dropV2("KEYS[1]", "KEYS[2]")}
return 1`;

/**
 * KEYS lock, users, holders, busy; ARGV the caller's exclusive token (or ''). Removes and returns
 * the holder fields without a live lease (expired fields are dropped without being returned: the
 * in-sandbox time limit ended their commands); claims an older kernel's busy marker only for the
 * caller holding the exclusive lease (`cur == token`, so no shared lease is live and killing
 * everything cannot hit a live sibling). The v2 marker is never claimed; it goes with the last
 * record. Returns { legacy, tag… }.
 */
const CLAIM = sharedLeaseReadScript(`local out = {0}
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
${dropV2("KEYS[3]", "KEYS[4]")}
local b = redis.call('GET', KEYS[4])
if ARGV[1] ~= '' and cur == ARGV[1] and b and b ~= '${BUSY_V2}' then
  redis.call('DEL', KEYS[4])
  out[1] = 1
end
return out`);

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

/** A signal that aborts with {@link SandboxLockLostError} when `lost` aborts. */
function lostSignal(lost: AbortSignal, conv: string): AbortSignal {
  const ctl = new AbortController();
  const abort = () => ctl.abort(new SandboxLockLostError(conv));
  if (lost.aborted) abort();
  else lost.addEventListener("abort", abort, { once: true });
  return ctl.signal;
}

/** A path lease this process holds. */
export interface SandboxPathLease {
  /** Aborts with {@link SandboxLockLostError} when the lease is lost. */
  readonly signal: AbortSignal;
  release(): Promise<void>;
}

/** The timings of {@link SandboxLeases} (each defaults as documented). */
export interface SandboxLeaseTimings {
  /** Lease TTL (ms), default {@link SANDBOX_LOCK_TTL_MS}. */
  ttlMs: number;
  /** Poll interval while waiting (ms, jittered up to 2×), default 100. */
  pollMs: number;
  /** Path lease TTL (ms), default {@link PATH_LEASE_TTL_MS}. */
  pathTtlMs: number;
}

/** Optional provider: {@link SandboxLeaseTimings} that replace some defaults (tests make them shorter). */
export const SANDBOX_LEASE_TIMINGS = Symbol("SANDBOX_LEASE_TIMINGS");

/**
 * The lease protocol over {@link LockService}'s shared leases; no state in process beyond the
 * leases this process holds.
 */
@Injectable()
export class SandboxLeases {
  /** Lease TTL (ms). */
  readonly ttlMs: number;
  /** Poll interval while waiting (ms, jittered up to 2×). */
  readonly pollMs: number;
  /** Path lease TTL (ms). */
  readonly pathTtlMs: number;

  constructor(
    @Inject(LockService) private readonly locks: LockService,
    /** The holder records and the legacy busy marker (scripts of this file). */
    @Inject(REDIS) private readonly redis: Pick<Redis, "eval" | "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Optional() @Inject(SANDBOX_LEASE_TIMINGS) timings: Partial<SandboxLeaseTimings> = {},
  ) {
    this.ttlMs = timings.ttlMs ?? SANDBOX_LOCK_TTL_MS;
    this.pollMs = timings.pollMs ?? 100;
    this.pathTtlMs = timings.pathTtlMs ?? PATH_LEASE_TTL_MS;
  }

  /**
   * TTL of an intent (ms): 4 × the poll interval (a jittered wait is up to 2 × the interval plus
   * round trips), at least {@link INTENT_TTL_FLOOR_MS} so event-loop lag cannot let it lapse.
   */
  private get intentTtlMs(): number {
    return Math.max(this.pollMs * 4, INTENT_TTL_FLOOR_MS);
  }

  private keys(conv: string): SharedLeaseKeys {
    return {
      lock: `${SANDBOX_LOCK_PREFIX}${conv}`,
      users: `${USERS_PREFIX}${conv}`,
      intent: `${INTENT_PREFIX}${conv}`,
    };
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
      const lease = await this.tryShared(conv, cap, token);
      if (lease) return lease;
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
    try {
      for (;;) {
        if (signal.aborted) throw abortReason(signal);
        const lease = await this.tryExclusive(conv, { token, intent: o.intent === true });
        if (lease) return lease;
        if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
        await this.wait(signal);
      }
    } catch (e) {
      if (o.intent) {
        await this.clearIntent(conv, token).catch((err: unknown) =>
          this.log.warn("cannot clear sandbox intent", { conversationId: conv, err }),
        );
      }
      throw e;
    }
  }

  /**
   * One try at an exclusive lease; null when any lease exists. Without `o` (sweeps) it sets no
   * intent. With `o.token` the lease (and, when `o.intent`, the intent set on failure) carries that
   * token, so one waiter can alternate between this and {@link tryShared} with the same token.
   */
  async tryExclusive(
    conv: string,
    o: { token?: string; intent?: boolean } = {},
  ): Promise<SandboxLease | null> {
    const h = await this.locks.tryExclusive(
      this.keys(conv),
      o.token ?? randomUUID(),
      this.ttlMs,
      o.intent ? this.intentTtlMs : undefined,
    );
    return h ? this.held(conv, h) : null;
  }

  /**
   * One try at a shared lease (`cap` holders at most); null when it is not granted. `token` is the
   * lease token; a waiter that set an intent with the same token is let through its own intent
   * (it should then {@link clearIntent}).
   */
  async tryShared(
    conv: string,
    cap: number,
    token: string = randomUUID(),
  ): Promise<SandboxLease | null> {
    const h = await this.locks.tryShared(this.keys(conv), token, cap, this.ttlMs);
    return h ? this.held(conv, h) : null;
  }

  /** Deletes the conversation's intent when it is `token`'s. */
  async clearIntent(conv: string, token: string): Promise<void> {
    await this.locks.releaseIf(this.keys(conv).intent, token);
  }

  /** Whether the single busy marker of a kernel before phase C is present (v2 does not count). */
  async legacyMarker(conv: string): Promise<boolean> {
    const v = await this.redis.get(`${SANDBOX_BUSY_PREFIX}${conv}`);
    return v !== null && v !== BUSY_V2;
  }

  /** Live shared leases of the conversation. */
  sharedCount(conv: string): Promise<number> {
    return this.locks.sharedCount(this.keys(conv));
  }

  /**
   * Records (or refreshes) a holder that may run commands (before its provider calls); `ttlMs`
   * bounds the record. Also keeps the v2 busy marker for older replicas ({@link BUSY_V2}).
   */
  async registerHolder(conv: string, token: string, ttlMs: number): Promise<void> {
    await this.redis.eval(
      REGISTER,
      2,
      `${HOLDERS_PREFIX}${conv}`,
      `${SANDBOX_BUSY_PREFIX}${conv}`,
      token,
      ttlMs,
    );
  }

  /** Deletes a holder record (after its provider calls); the v2 marker goes with the last one. */
  async unregisterHolder(conv: string, token: string): Promise<void> {
    await this.redis.eval(
      UNREGISTER,
      2,
      `${HOLDERS_PREFIX}${conv}`,
      `${SANDBOX_BUSY_PREFIX}${conv}`,
      token,
    );
  }

  /**
   * Tags of holders without a live lease, plus whether an older kernel's single busy marker was
   * present. Atomically claims them (removes the fields) so only one caller kills. That marker is
   * claimed only when `exclusiveToken` is the caller's exclusive lease (no shared lease live).
   */
  async claimDeadHolders(
    conv: string,
    exclusiveToken?: string,
  ): Promise<{ tags: string[]; legacyMarker: boolean }> {
    const { lock, users } = this.keys(conv);
    const r = (await this.redis.eval(
      CLAIM,
      4,
      lock,
      users,
      `${HOLDERS_PREFIX}${conv}`,
      `${SANDBOX_BUSY_PREFIX}${conv}`,
      exclusiveToken ?? "",
    )) as [number, ...string[]];
    const [legacy, ...tags] = r;
    return { tags, legacyMarker: Number(legacy) === 1 };
  }

  /**
   * A short lease on one path of the sandbox (the kernel's own read-modify-write of a file); waits
   * up to `capMs`, then throws {@link SandboxPathBusyError}. A {@link LockService.hold} lease
   * (renewed every TTL / 3): when it is lost its `signal` aborts.
   */
  async pathLease(
    conv: string,
    path: string,
    signal: AbortSignal,
    capMs: number,
  ): Promise<SandboxPathLease> {
    const key = `${PATH_PREFIX}${conv}:${createHash("sha256").update(path).digest("hex")}`;
    const token = randomUUID();
    const deadline = Date.now() + capMs;
    let h: LeaseHandle | undefined;
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      h = await this.locks.hold(key, token, this.pathTtlMs);
      if (h) break;
      if (Date.now() + this.pollMs > deadline) throw new SandboxPathBusyError();
      await this.wait(signal);
    }
    const held = h;
    return { signal: lostSignal(held.lost, conv), release: () => held.release() };
  }

  /** A sandbox lease over a held {@link SharedLeaseHandle}, as its current kind. */
  private held(conv: string, h: SharedLeaseHandle): SandboxLease {
    return this.view(conv, h, lostSignal(h.lost, conv), h.kind);
  }

  /** A lease view of `h` as `kind`; a view stops working once the lease changes kind. */
  private view(
    conv: string,
    h: SharedLeaseHandle,
    signal: AbortSignal,
    kind: LeaseKind,
  ): SandboxLease {
    const current = () => h.kind === kind;
    return {
      kind,
      token: h.token,
      conversationId: conv,
      signal,
      // a Redis error is warned, not thrown: the deadline decides whether the lease is lost
      renew: async () => {
        if (!current()) return false;
        try {
          return await h.renew();
        } catch (err) {
          this.log.warn("sandbox lease renew failed", { conversationId: conv, err });
          return !signal.aborted;
        }
      },
      // Any view releases the lease in its current kind (a caller that kept only the exclusive
      // view after a downgrade must not leak the shared lease, which would renew forever)
      release: () => h.release(),
      downgrade: async () => {
        if (!current() || h.kind !== "exclusive") throw new Error("sandbox lease is not exclusive");
        if (signal.aborted) throw abortReason(signal);
        if (!(await h.downgrade())) throw new SandboxLockLostError(conv);
        return this.view(conv, h, signal, "shared");
      },
    };
  }
}
