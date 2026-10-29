// Ported from octok-platform libs/common/src/decorators/with-lock.decorator.ts and
// libs/flow/src/runtime/redis-token-lock.ts (owner-approved, 2026-10-28).
// Adapted to the kernel: pino logger, ApiError, and a `lost` signal when renewal fails.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../../errors.js";
import type { KernelLogger } from "../../log.js";
import { KERNEL_LOGGER, REDIS } from "../tokens.js";

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
  /** Aborts when the lock was lost: the key is gone or taken, or renewal failed until the next attempt would land past expiry. */
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
      if ((await this.redis.set(lockKey, token, "PX", Math.ceil(opts.ttlMs), "NX")) === "OK") {
        this.log.debug("lock acquired", { lockKey });
        return this.watch(lockKey, token, opts.ttlMs);
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
    if (!(await this.lease(key, holder, ttlMs))) return undefined;
    return this.watch(key, holder, ttlMs);
  }

  /** The renewal watchdog of a key we just took. */
  private watch(lockKey: string, token: string, ttlMs: number): LeaseHandle {
    const lost = new AbortController();
    let released = false;
    let stopped = false;
    let lastOk = Date.now();
    const stop = () => {
      stopped = true;
      clearInterval(timer);
    };
    const lose = (reason: string) => {
      if (released || lost.signal.aborted) return;
      this.log.warn(reason, { lockKey });
      lost.abort(new Error(`lock lost: ${lockKey}`));
      stop();
    };
    const intervalMs = Math.max(1, Math.floor(ttlMs / 3));
    const timer = setInterval(() => {
      this.renew(lockKey, token, ttlMs).then(
        (ok) => {
          if (released || stopped) return;
          if (ok) lastOk = Date.now();
          else lose("lock lost: the key is gone or taken");
        },
        (err: unknown) => {
          if (released || stopped) return;
          // A transient Redis error: try again next tick, unless the next tick would land past
          // expiry (then another replica may already hold the key): report the loss now.
          if (Date.now() - lastOk >= ttlMs - intervalMs) {
            lose("lock lost: renewal kept failing");
          } else {
            this.log.warn("lock renewal failed", { lockKey, err });
          }
        },
      );
    }, intervalMs);
    timer.unref();
    return {
      lost: lost.signal,
      renew: async () => {
        if (released || lost.signal.aborted) return false;
        const ok = await this.renew(lockKey, token, ttlMs);
        if (ok) lastOk = Date.now();
        else lose("lock lost: the key is gone or taken");
        return ok;
      },
      abandon: stop,
      release: async () => {
        if (released) return;
        released = true;
        stop();
        try {
          if (!(await this.releaseIf(lockKey, token))) {
            this.log.warn("lock was not ours at release (expired or taken)", { lockKey });
          }
        } catch (err) {
          this.log.error("lock release failed", { lockKey, err });
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
