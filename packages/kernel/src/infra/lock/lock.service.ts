// Ported from octok-platform libs/common/src/decorators/with-lock.decorator.ts and
// libs/flow/src/runtime/redis-token-lock.ts (owner-approved, 2026-10-28).
// Adapted to the kernel: pino logger, ApiError, and a `lost` signal when renewal fails.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../../errors.js";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER, REDIS } from "../tokens.js";
import {
  ACQUIRE_EXCLUSIVE,
  ACQUIRE_SHARED,
  COUNT_SHARED_LEASES,
  DOWNGRADE_SHARED_LEASE,
  RELEASE_SHARED_LEASE,
  RENEW_SHARED_LEASE,
  type SharedLeaseKeys,
  type SharedLeaseKind,
} from "./shared-lease.js";

export interface AcquireOptions {
  /** Lock lifetime without renewal; a crashed holder's lock expires within it. */
  ttlMs: number;
  /** How long to keep trying; 0 (default) tries once, `Infinity` waits until it is taken. */
  waitMs?: number;
  /** Pause between attempts while waiting (default 100). */
  retryMs?: number;
  /** Ends the wait: the call throws the signal's reason (checked before the first attempt too). */
  signal?: AbortSignal;
}

export interface LockHandle {
  /** Stops renewing and deletes the key if it is still ours. Idempotent. */
  release(): Promise<void>;
  /**
   * Aborts when the lock was lost: the key is gone or taken, or no renewal succeeded by the
   * deadline (send time of the last successful renewal + TTL − TTL/3, R19).
   */
  readonly lost: AbortSignal;
}

/**
 * A renewed lease ({@link LockService.hold}): a {@link LockHandle} whose holder value is the
 * caller's (other replicas read it), with an explicit renewal and an abandon for a holder that
 * hands the key over to its TTL.
 */
export interface LeaseHandle extends LockHandle {
  /** Renews now; false (and `lost` aborts) when the key is no longer ours. */
  renew(): Promise<boolean>;
  /** Stops renewing without deleting: the key expires within its TTL. `release` still deletes it while ours. */
  abandon(): void;
}

/**
 * A held lease of a shared lease ({@link LockService.tryShared} / {@link LockService.tryExclusive}):
 * renewed every TTL/3 like {@link LockService.hold} (R19 loss), released in its current kind.
 */
export interface SharedLeaseHandle extends LeaseHandle {
  readonly token: string;
  /** `exclusive` until a successful {@link downgrade}, then `shared`. */
  readonly kind: SharedLeaseKind;
  /**
   * exclusive → shared in one step (same token, same `lost`; the deadline moves like a renewal).
   * False (and `lost` aborts) when the exclusive lease was no longer ours. Throws when the lease is
   * not exclusive (any more) or was released.
   */
  downgrade(): Promise<boolean>;
}

/** The renewal watchdog's handle with a one-off renewal through another operation. */
interface Watched extends LeaseHandle {
  /** Like `renew()`, through `op` (a success moves the deadline, `false` loses the lease). */
  renewWith(op: () => Promise<boolean>): Promise<boolean>;
}

/** Deletes the key only while it holds our token. */
const RELEASE_IF = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
/** Extends the key only while it holds our token. */
const RENEW_IF = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], tonumber(ARGV[2])) else return 0 end`;

/** Resolves after `ms`; rejects with the abort reason when `signal` aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
export const prefixed = (key: string) => (key.startsWith("lock:") ? key : `lock:${key}`);

/**
 * Redis distributed locks: `SET NX PX` with a Lua compare-and-delete release and a watchdog that
 * renews every TTL/3 (short lock plus renewal: a long job keeps it, a crashed holder's lock
 * expires within the TTL). Also the primitives for leases whose holder is a caller-chosen string
 * (`lease` / `renew` / `releaseIf`, used by the sandbox leases).
 */
@Injectable()
export class LockService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /**
   * Tries to take `lock:<key>`; resolves `undefined` when it stays held by someone else until
   * `waitMs` ran out. An aborted `signal` throws its reason instead.
   */
  async acquire(key: string, opts: AcquireOptions): Promise<LockHandle | undefined> {
    const lockKey = prefixed(key);
    const token = randomUUID();
    const deadline = Date.now() + (opts.waitMs ?? 0);
    const retryMs = opts.retryMs ?? 100;
    for (;;) {
      opts.signal?.throwIfAborted();
      const sentAt = Date.now();
      if ((await this.redis.set(lockKey, token, "PX", Math.ceil(opts.ttlMs), "NX")) === "OK") {
        this.log.debug("lock acquired", { lockKey });
        return this.watch(lockKey, token, opts.ttlMs, sentAt);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // Contention is normal in a multi-replica deployment, not an error.
        this.log.info("lock held elsewhere", { lockKey });
        return undefined;
      }
      await sleep(Math.min(retryMs, remaining), opts.signal);
    }
  }

  /** Runs `fn` under the lock; throws `lock.acquire_failed` when it cannot be taken. */
  async run<T>(
    key: string,
    opts: AcquireOptions,
    fn: (handle: LockHandle) => Promise<T>,
  ): Promise<T> {
    const handle = await this.acquire(key, opts);
    if (!handle) throw lockAcquireFailed(prefixed(key));
    try {
      return await fn(handle);
    } finally {
      await handle.release();
    }
  }

  /** Sets `key` to `holder` for `ttlMs` unless it exists (no `lock:` prefix, no renewal timer). */
  async lease(key: string, holder: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(key, holder, "PX", Math.ceil(ttlMs), "NX")) === "OK";
  }

  /** Extends `key` to `ttlMs` when `holder` still owns it. */
  async renew(key: string, holder: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(RENEW_IF, 1, key, holder, String(Math.ceil(ttlMs)))) === 1;
  }

  /** The holder value of `key` (a lease's or a lock's token); null when nobody holds it. */
  holderOf(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /** Deletes `key` when `holder` still owns it. */
  async releaseIf(key: string, holder: string): Promise<boolean> {
    return (await this.redis.eval(RELEASE_IF, 1, key, holder)) === 1;
  }

  /**
   * Takes `key` (no `lock:` prefix) with the caller's `holder` value for `ttlMs`, unless it is
   * held, and renews it every TTL/3 like {@link acquire} (a run longer than the TTL keeps it, a
   * crashed holder's key expires within the TTL). Resolves `undefined` when the key is held; tries
   * once. For leases whose holder other replicas read (the conversation run lock: the run id).
   */
  async hold(key: string, holder: string, ttlMs: number): Promise<LeaseHandle | undefined> {
    const sentAt = Date.now();
    if (!(await this.lease(key, holder, ttlMs))) return undefined;
    return this.watch(key, holder, ttlMs, sentAt);
  }

  /**
   * One try at a shared lease of `keys` for `token` (at most `cap` shared holders; not granted
   * while an exclusive holder, another `SET NX` value of the lock key or another token's intent
   * exists). Resolves `undefined` when not granted; a granted lease is renewed every TTL/3.
   */
  async tryShared(
    keys: SharedLeaseKeys,
    token: string,
    cap: number,
    ttlMs: number,
  ): Promise<SharedLeaseHandle | undefined> {
    const sentAt = Date.now();
    const ok = await this.redis.eval(
      ACQUIRE_SHARED,
      3,
      keys.lock,
      keys.users,
      keys.intent,
      token,
      cap,
      Math.ceil(ttlMs),
    );
    return Number(ok) === 1 ? this.watchShared(keys, token, "shared", ttlMs, sentAt) : undefined;
  }

  /**
   * One try at the exclusive lease of `keys` for `token` (granted only when no lease of either
   * kind exists). With `intentTtlMs` a failed try sets (or refreshes) the intent to `token` unless
   * another token's intent exists, so new shared leases wait; a successful try clears our intent.
   */
  async tryExclusive(
    keys: SharedLeaseKeys,
    token: string,
    ttlMs: number,
    intentTtlMs?: number,
  ): Promise<SharedLeaseHandle | undefined> {
    const sentAt = Date.now();
    const ok = await this.redis.eval(
      ACQUIRE_EXCLUSIVE,
      3,
      keys.lock,
      keys.users,
      keys.intent,
      token,
      Math.ceil(ttlMs),
      intentTtlMs === undefined ? 0 : 1,
      Math.ceil(intentTtlMs ?? 0),
    );
    return Number(ok) === 1 ? this.watchShared(keys, token, "exclusive", ttlMs, sentAt) : undefined;
  }

  /** Live shared leases of `keys` (expired ones are purged first). */
  async sharedCount(keys: Pick<SharedLeaseKeys, "lock" | "users">): Promise<number> {
    return Number(await this.redis.eval(COUNT_SHARED_LEASES, 2, keys.lock, keys.users));
  }

  /** The watchdog of a shared lease we just took; its kind changes once, on a downgrade. */
  private watchShared(
    keys: SharedLeaseKeys,
    token: string,
    initial: SharedLeaseKind,
    ttlMs: number,
    sentAt: number,
  ): SharedLeaseHandle {
    let kind = initial;
    let released = false;
    /** The DOWNGRADE eval in flight, if any. */
    let downgrading: Promise<boolean> | undefined;
    const ttl = String(Math.ceil(ttlMs));
    const w = this.watchdog(
      keys.lock,
      ttlMs,
      {
        renew: async () =>
          Number(
            await this.redis.eval(RENEW_SHARED_LEASE, 2, keys.lock, keys.users, token, ttl, kind),
          ) === 1,
        release: async () => {
          // a downgrade still in flight decides the kind the lease has in Redis
          await downgrading?.catch(() => {});
          await this.redis.eval(RELEASE_SHARED_LEASE, 2, keys.lock, keys.users, token, kind);
        },
      },
      sentAt,
    );
    return {
      token,
      get kind() {
        return kind;
      },
      lost: w.lost,
      renew: () => w.renew(),
      abandon: () => w.abandon(),
      release: async () => {
        released = true;
        await w.release();
      },
      downgrade: async () => {
        if (kind !== "exclusive" || released) throw new Error("lease is not exclusive");
        w.lost.throwIfAborted();
        return w.renewWith(async () => {
          downgrading = this.redis
            .eval(DOWNGRADE_SHARED_LEASE, 2, keys.lock, keys.users, token, ttl)
            .then((r) => Number(r) === 1);
          try {
            const done = await downgrading;
            // Redis made it shared: record that even when the lease was lost or released while the
            // call was in flight, so the release removes the shared member (no leak)
            if (done) kind = "shared";
            return done;
          } finally {
            downgrading = undefined;
          }
        });
      },
    };
  }

  /** The renewal watchdog of a key we just took (the `SET NX` was sent at `sentAt`). */
  private watch(lockKey: string, token: string, ttlMs: number, sentAt: number): LeaseHandle {
    return this.keepAlive(
      lockKey,
      ttlMs,
      {
        renew: () => this.renew(lockKey, token, ttlMs),
        release: async () => {
          if (!(await this.releaseIf(lockKey, token))) {
            this.log.warn("lock was not ours at release (expired or taken)", { lockKey });
          }
        },
      },
      sentAt,
    );
  }

  /**
   * The renewal watchdog for a lease kept by other means than a `SET NX` key (e.g. an org quota
   * slot, a member of a Redis sorted set): calls `ops.renew` every TTL/3 while held. A renewal
   * answered `false` marks it lost at once (`lost` aborts, one WARN `lock lost` with `label`).
   * R19: loss is a deadline, not a counter. The deadline is the send time of the last successful
   * renewal (or of the acquire, `acquiredAt`, default now) + TTL − TTL/3; any successful renewal
   * through the handle (the watchdog's or an explicit `renew()`) moves it; when it passes without
   * one, `lost` aborts, even with a renewal still in flight. So a holder gives up one renewal
   * period before the key can expire elsewhere. `release` stops renewing and calls `ops.release`
   * once.
   */
  keepAlive(
    label: string,
    ttlMs: number,
    ops: { renew(): Promise<boolean>; release(): Promise<void> },
    acquiredAt: number = Date.now(),
  ): LeaseHandle {
    return this.watchdog(label, ttlMs, ops, acquiredAt);
  }

  /** {@link keepAlive}'s implementation, with {@link Watched.renewWith}. */
  private watchdog(
    label: string,
    ttlMs: number,
    ops: { renew(): Promise<boolean>; release(): Promise<void> },
    acquiredAt: number,
  ): Watched {
    const lockKey = label;
    const lost = new AbortController();
    let released = false;
    let stopped = false;
    const intervalMs = Math.max(1, Math.floor(ttlMs / 3));
    /** Send time of the last successful renewal (or of the acquire). */
    let lastOkSentAt = acquiredAt;
    let deadline: NodeJS.Timeout | undefined;
    const stop = () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(deadline);
    };
    const lose = (reason: string) => {
      if (released || lost.signal.aborted) return;
      this.log.warn(reason, { lockKey });
      lost.abort(new Error(`lock lost: ${lockKey}`));
      stop();
    };
    const deadlineAt = () => lastOkSentAt + ttlMs - intervalMs;
    const arm = () => {
      clearTimeout(deadline);
      if (stopped) return;
      const ms = Math.max(0, deadlineAt() - Date.now());
      deadline = setTimeout(() => lose("lock lost: renewal kept failing"), ms);
      deadline.unref();
    };
    /** One renewal: a success moves the deadline (by its send time), `false` loses the lease. */
    const renewOnce = async (op: () => Promise<boolean> = () => ops.renew()): Promise<boolean> => {
      const sentAt = Date.now();
      const ok = await op();
      if (released || lost.signal.aborted) return false;
      if (!ok) {
        lose("lock lost: the key is gone or taken");
        return false;
      }
      if (sentAt > lastOkSentAt) {
        lastOkSentAt = sentAt;
        arm();
      }
      return true;
    };
    const timer = setInterval(() => {
      // the deadline timer decides the loss; this check only backs it up on the watchdog's own
      // clock (both fire at the deadline: never earlier)
      if (Date.now() >= deadlineAt()) {
        lose("lock lost: renewal kept failing");
        return;
      }
      renewOnce().catch((err: unknown) => {
        if (released || stopped) return;
        // a transient Redis error: the next tick retries; the deadline decides the loss
        this.log.warn("lock renewal failed", { lockKey, err });
      });
    }, intervalMs);
    timer.unref();
    arm();
    return {
      lost: lost.signal,
      // an explicit renewal: a Redis error is thrown to the caller, not logged (the watchdog's
      // own failures are, once each)
      renew: async () => {
        if (released || lost.signal.aborted) return false;
        return renewOnce();
      },
      renewWith: async (op) => {
        if (released || lost.signal.aborted) return false;
        return renewOnce(op);
      },
      abandon: stop,
      release: async () => {
        if (released) return;
        released = true;
        stop();
        try {
          await ops.release();
        } catch (err) {
          // warn: the key expires within its TTL anyway (controller ruling, Task 3.8)
          this.log.warn("lock release failed", { lockKey, err });
        }
      },
    };
  }
}

export function lockAcquireFailed(lockKey: string): ApiError {
  return new ApiError("lock.acquire_failed", "The operation is already in progress; retry later.", [
    { lockKey },
  ]);
}
