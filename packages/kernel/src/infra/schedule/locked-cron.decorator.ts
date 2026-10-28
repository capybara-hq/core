// Packages octok-platform's two-layer cron pattern (@Cron plus a try-once Redis lock in the job,
// e.g. libs/app/src/billing/service/subscription-reconcile.job.ts; owner-approved, 2026-10-28).
import { Cron, type CronOptions } from "@nestjs/schedule";
import type { KernelLogger } from "../../log.js";
import { withLogContext } from "../../log-context.js";
import { runOutsideTransaction } from "../database/transaction-host.js";
import type { LockService } from "../lock/lock.service.js";
import { scheduledTick } from "./cron-tick.js";

interface LockedCronHost {
  lockService?: LockService;
  log?: KernelLogger;
}

export interface LockedCronOptions extends Pick<CronOptions, "timeZone"> {
  /** Unique job name (the scheduler registry key and the log field). */
  name: string;
  /** Redis lock key (default `cron:<name>`); `lock:` is prepended unless present. */
  lockKey?: string;
  /** Lock lifetime without renewal, ms (default 30000); a longer run keeps it by renewal. */
  ttl?: number;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * `@Cron` with exactly-once-per-tick across replicas: every replica's scheduler fires, the one that
 * sets the per-tick marker (`cron:<name>:<scheduled tick ms>`, never released) takes a try-once
 * renewed run lock and runs the job; the others log INFO and skip, as does a tick whose
 * predecessor is still running. An error in the job is logged (never thrown into the scheduler)
 * and the lock is released afterwards. The job starts in a fresh async context (no transaction).
 * The class must inject `lockService` and `log`:
 *
 * ```ts
 * constructor(
 *   @Inject(LockService) readonly lockService: LockService,
 *   @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
 * ) {}
 * ```
 */
export function LockedCron(expression: string, options: LockedCronOptions) {
  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const lockKey = options.lockKey ?? `cron:${options.name}`;
    descriptor.value = async function (this: LockedCronHost, ...args: unknown[]) {
      const { lockService, log } = this;
      if (!lockService || !log) {
        throw new Error(
          "@LockedCron() needs the class to inject `LockService` as `lockService` and the " +
            "logger as `log`.",
        );
      }
      await runOutsideTransaction(() =>
        withLogContext({ cron: options.name }, async () => {
          // Layer 1: one winner per scheduled tick. The marker is never released: a fast job on the
          // winner must not let a slower replica run the same tick again.
          let tick: number;
          try {
            const t = scheduledTick(expression, Date.now(), options.timeZone);
            tick = t.tick;
            const ttl = Math.min(Math.max(t.periodMs * 2, 10_000), 24 * 3600_000);
            if (!(await lockService.lease(`cron:${options.name}:${tick}`, "tick", ttl))) {
              log.info("cron skipped: tick already taken by another replica", {
                cron: options.name,
                tick,
              });
              return;
            }
          } catch (err) {
            log.error("cron tick marker failed", { cron: options.name, err });
            return;
          }
          // Layer 2: the renewed run lock, so a long run never overlaps the next tick's run.
          let handle: Awaited<ReturnType<LockService["acquire"]>>;
          try {
            handle = await lockService.acquire(lockKey, {
              ttlMs: options.ttl ?? 30_000,
              waitMs: 0,
            });
          } catch (err) {
            log.error("cron lock failed", { cron: options.name, err });
            return;
          }
          if (!handle) {
            log.info("cron skipped: the previous run still holds the lock", {
              cron: options.name,
              tick,
            });
            return;
          }
          try {
            await original.apply(this, args);
          } catch (err) {
            log.error("cron job failed", { cron: options.name, error: errMsg(err), err });
          } finally {
            await handle.release();
          }
        }),
      );
    };
    // The scheduler reads the metadata from the final method, so register after wrapping.
    Cron(expression, {
      name: options.name,
      ...(options.timeZone !== undefined && { timeZone: options.timeZone }),
    })(target, key, descriptor);
    return descriptor;
  };
}
