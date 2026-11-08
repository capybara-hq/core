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
 * Shared and exclusive sandbox leases (sub-agents spec §10.3; environments spec §4.2): the Redis
 * protocol that lets several holders (every conversation bound to the device, and their
 * sub-agents) use one device's running instance concurrently (shared leases: commands, file
 * reads and writes) while lifecycle changes (create, resume, rebuild, suspend, destroy, reset) stay
 * alone (exclusive leases). Every `sandbox@2` provider runs commands concurrently and kills by tag,
 * so there is no single-holder mode. Keys, env = the device id:
 *
 * - `capk:sandbox:<env>`: the lock key: an exclusive holder's token, or `shared` while shared
 *   leases exist.
 * - `capk:sandbox-users:<env>`: sorted set of shared lease tokens scored by their expiry (ms, Redis
 *   server clock).
 * - `capk:sandbox-intent:<env>`: an exclusive waiter's token (writer preference); while it exists
 *   no new shared lease is granted.
 * - `capk:sandbox-holders:<env>`: hash token → expiry of holders that may have commands running;
 *   a record without a live lease is a crashed holder whose commands (tagged with its token) are
 *   killed by the next acquirer.
 * - `capk:sandbox-path:<env>:<sha256hex(path)>`: a short per-path lease around the kernel's own
 *   read-modify-write of one file.
 *
 * The first three keys are a {@link LockService} shared lease (`tryShared` / `tryExclusive`,
 * infra/lock/shared-lease.ts); the holder records and the path leases are this file's. Every key
 * carries a TTL. A holder renews every TTL / 3 (LockService's watchdog) and loses the lease at
 * the renewal deadline (send time of the last successful renewal + 2/3 TTL): its `signal` aborts
 * with {@link SandboxLockLostError}.
 */

/** Prefix of the lock key `capk:sandbox:<deviceId>`. */
export const SANDBOX_LOCK_PREFIX = "capk:sandbox:";
/** TTL of a lease (ms): renewed every TTL / 3 while held. */
export const SANDBOX_LOCK_TTL_MS = 60_000;
const USERS_PREFIX = "capk:sandbox-users:";
const INTENT_PREFIX = "capk:sandbox-intent:";
const HOLDERS_PREFIX = "capk:sandbox-holders:";
const PATH_PREFIX = "capk:sandbox-path:";
/** TTL of a path lease (ms); renewed while held. */
const PATH_LEASE_TTL_MS = 30_000;
/** Shortest life of an exclusive waiter's intent (ms): outlasts event-loop lag between polls. */
const INTENT_TTL_FLOOR_MS = 2000;

/** The device's sandbox is busy: waited longer than `sandbox.lockWaitSeconds` (409). */
export const sandboxBusy = (): ApiError =>
  new ApiError(
    "sandbox.busy",
    "The sandbox of this device is busy with other commands; wait for them to finish and try again",
  );

/** A lease was lost while held, or the record changed under it (generation mismatch). */
export class SandboxLockLostError extends Error {
  /** `lock`: the lease was lost (renewal failed or none succeeded in time); `generation`: the record's fence changed. */
  readonly reason: "lock" | "generation";

  constructor(deviceId: string, reason: "lock" | "generation" = "lock") {
    super(
      reason === "lock"
        ? `sandbox lock lost for device ${deviceId}`
        : `sandbox state of device ${deviceId} changed concurrently (generation mismatch)`,
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
  readonly deviceId: string;
  /** Aborts with {@link SandboxLockLostError} when the lease is lost. */
  readonly signal: AbortSignal;
  /** Renews once now; false when the lease is lost (the signal then aborts). */
  renew(): Promise<boolean>;
  /** Stops renewing and releases the lease (only this holder's). */
  release(): Promise<void>;
  /** exclusive → shared in one Lua step (same token, same signal); throws if not exclusive. */
  downgrade(): Promise<SandboxLease>;
}

/** KEYS holders; ARGV token, ttl. The hash is kept for at least `ttl`. */
const REGISTER = redisClockScript(`local ttl = tonumber(ARGV[2])
redis.call('HSET', KEYS[1], ARGV[1], now + ttl)
if redis.call('PTTL', KEYS[1]) < ttl then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1`);

/**
 * KEYS lock, users, holders. Removes and returns the holder fields without a live lease (expired
 * fields are dropped without being returned: the in-sandbox time limit ended their commands). The
 * caller's own token is live (a shared lease, or the exclusive token in the lock key), so it is
 * never returned. Returns the tags.
 */
const CLAIM = sharedLeaseReadScript(`local out = {}
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
function lostSignal(lost: AbortSignal, env: string): AbortSignal {
  const ctl = new AbortController();
  const abort = () => ctl.abort(new SandboxLockLostError(env));
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
    /** The holder records (scripts of this file). */
    @Inject(REDIS) private readonly redis: Pick<Redis, "eval" | "hdel">,
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

  private keys(env: string): SharedLeaseKeys {
    return {
      lock: `${SANDBOX_LOCK_PREFIX}${env}`,
      users: `${USERS_PREFIX}${env}`,
      intent: `${INTENT_PREFIX}${env}`,
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
    env: string,
    cap: number,
    signal: AbortSignal,
    capMs: number,
  ): Promise<SandboxLease> {
    const token = randomUUID();
    const deadline = Date.now() + capMs;
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      const lease = await this.tryShared(env, cap, token);
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
    env: string,
    signal: AbortSignal,
    capMs?: number,
    o: { intent?: boolean } = {},
  ): Promise<SandboxLease> {
    const token = randomUUID();
    const deadline = capMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + capMs;
    try {
      for (;;) {
        if (signal.aborted) throw abortReason(signal);
        const lease = await this.tryExclusive(env, { token, intent: o.intent === true });
        if (lease) return lease;
        if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
        await this.wait(signal);
      }
    } catch (e) {
      if (o.intent) {
        await this.clearIntent(env, token).catch((err: unknown) =>
          this.log.warn("cannot clear sandbox intent", { deviceId: env, err }),
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
    env: string,
    o: { token?: string; intent?: boolean } = {},
  ): Promise<SandboxLease | null> {
    const h = await this.locks.tryExclusive(
      this.keys(env),
      o.token ?? randomUUID(),
      this.ttlMs,
      o.intent ? this.intentTtlMs : undefined,
    );
    return h ? this.held(env, h) : null;
  }

  /**
   * One try at a shared lease (`cap` holders at most); null when it is not granted. `token` is the
   * lease token; a waiter that set an intent with the same token is let through its own intent
   * (it should then {@link clearIntent}).
   */
  async tryShared(
    env: string,
    cap: number,
    token: string = randomUUID(),
  ): Promise<SandboxLease | null> {
    const h = await this.locks.tryShared(this.keys(env), token, cap, this.ttlMs);
    return h ? this.held(env, h) : null;
  }

  /** Deletes the device's intent when it is `token`'s. */
  async clearIntent(env: string, token: string): Promise<void> {
    await this.locks.releaseIf(this.keys(env).intent, token);
  }

  /** Live shared leases of the device. */
  sharedCount(env: string): Promise<number> {
    return this.locks.sharedCount(this.keys(env));
  }

  /**
   * Records (or refreshes) a holder that may run commands (before its provider calls); `ttlMs`
   * bounds the record.
   */
  async registerHolder(env: string, token: string, ttlMs: number): Promise<void> {
    await this.redis.eval(REGISTER, 1, `${HOLDERS_PREFIX}${env}`, token, ttlMs);
  }

  /** Deletes a holder record (after its provider calls). */
  async unregisterHolder(env: string, token: string): Promise<void> {
    await this.redis.hdel(`${HOLDERS_PREFIX}${env}`, token);
  }

  /**
   * Tags of holders without a live lease, atomically claimed (their fields removed) so only one
   * caller kills them.
   */
  async claimDeadHolders(env: string): Promise<string[]> {
    const { lock, users } = this.keys(env);
    return (await this.redis.eval(CLAIM, 3, lock, users, `${HOLDERS_PREFIX}${env}`)) as string[];
  }

  /**
   * A short lease on one path of the sandbox (the kernel's own read-modify-write of a file); waits
   * up to `capMs`, then throws {@link SandboxPathBusyError}. A {@link LockService.hold} lease
   * (renewed every TTL / 3): when it is lost its `signal` aborts.
   */
  async pathLease(
    env: string,
    path: string,
    signal: AbortSignal,
    capMs: number,
  ): Promise<SandboxPathLease> {
    const key = `${PATH_PREFIX}${env}:${createHash("sha256").update(path).digest("hex")}`;
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
    return { signal: lostSignal(held.lost, env), release: () => held.release() };
  }

  /** A sandbox lease over a held {@link SharedLeaseHandle}, as its current kind. */
  private held(env: string, h: SharedLeaseHandle): SandboxLease {
    return this.view(env, h, lostSignal(h.lost, env), h.kind);
  }

  /** A lease view of `h` as `kind`; a view stops working once the lease changes kind. */
  private view(
    env: string,
    h: SharedLeaseHandle,
    signal: AbortSignal,
    kind: LeaseKind,
  ): SandboxLease {
    const current = () => h.kind === kind;
    return {
      kind,
      token: h.token,
      deviceId: env,
      signal,
      // a Redis error is warned, not thrown: the deadline decides whether the lease is lost
      renew: async () => {
        if (!current()) return false;
        try {
          return await h.renew();
        } catch (err) {
          this.log.warn("sandbox lease renew failed", { deviceId: env, err });
          return !signal.aborted;
        }
      },
      // Any view releases the lease in its current kind (a caller that kept only the exclusive
      // view after a downgrade must not leak the shared lease, which would renew forever)
      release: () => h.release(),
      downgrade: async () => {
        if (!current() || h.kind !== "exclusive") throw new Error("sandbox lease is not exclusive");
        if (signal.aborted) throw abortReason(signal);
        if (!(await h.downgrade())) throw new SandboxLockLostError(env);
        return this.view(env, h, signal, "shared");
      },
    };
  }
}
