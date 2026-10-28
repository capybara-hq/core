// Ported from octok-platform libs/common/src/decorators/with-lock.decorator.ts (owner-approved, 2026-10-28).
// Adapted: the LockService comes from the `lockService` property, as `@Transactional` reads `txHost`.
import { currentStore } from "../database/transaction-host.js";
import { generateKey } from "./key-template.js";
import { type LockService, lockAcquireFailed } from "./lock.service.js";

interface WithLockService {
  lockService?: LockService;
}

export interface WithLockOptions {
  /**
   * Lock key; `lock:` is prepended unless present. Placeholders expand from the method
   * arguments: `#{0}`, `#{1.book.title}`, `#{user.id}` (= `#{0.user.id}`).
   */
  key: string;
  /** Lock lifetime without renewal, ms (default 30000); the lock is renewed every TTL/3. */
  ttl?: number;
  /** How long to wait for the lock, ms (default 5000); 0 tries once. */
  waitTimeout?: number;
  /** Pause between attempts, ms (default 100). */
  retryInterval?: number;
}

/**
 * Method decorator: only one caller at a time, across replicas, runs the method for a given key.
 * Throws `ApiError("lock.acquire_failed")` (409, `details[0].lockKey`) when the lock is not
 * obtained in `waitTimeout`. The class must inject the service as a property named `lockService`:
 *
 * ```ts
 * constructor(@Inject(LockService) readonly lockService: LockService) {}
 * ```
 *
 * Never inside a transaction: the lock would be released before COMMIT.
 */
export function WithLock(options: WithLockOptions) {
  return (_target: object, _key: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = async function (this: WithLockService, ...args: unknown[]) {
      const service = this.lockService;
      if (!service) {
        throw new Error(
          "@WithLock() needs the class to inject `LockService` as `lockService` " +
            "(`@Inject(LockService) readonly lockService: LockService`).",
        );
      }
      if (currentStore()) {
        throw new Error("@WithLock() must not run inside a transaction: lock first, then open it.");
      }
      const key = generateKey(options.key, args);
      const handle = await service.acquire(key, {
        ttlMs: options.ttl ?? 30_000,
        waitMs: options.waitTimeout ?? 5_000,
        retryMs: options.retryInterval ?? 100,
      });
      if (!handle) throw lockAcquireFailed(key.startsWith("lock:") ? key : `lock:${key}`);
      try {
        return await original.apply(this, args);
      } finally {
        await handle.release();
      }
    };
    return descriptor;
  };
}
