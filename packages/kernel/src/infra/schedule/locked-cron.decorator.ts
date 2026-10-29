// Packages octok-platform's two-layer cron pattern (@Cron plus a try-once Redis lock in the job,
// e.g. libs/app/src/billing/service/subscription-reconcile.job.ts; owner-approved, 2026-10-28).
import { Cron, type CronOptions } from "@nestjs/schedule";
import { scheduledTick } from "./cron-tick.js";
import {
  assertLockedJobHost,
  LOCKED_JOB,
  type LockedJobHost,
  runLockedTick,
} from "./locked-tick.js";

export interface LockedCronOptions extends Pick<CronOptions, "timeZone"> {
  /** Unique job name (the scheduler registry key and the log field). */
  name: string;
  /** Redis lock key (default `cron:<name>`); `lock:` is prepended unless present. */
  lockKey?: string;
  /** Lock lifetime without renewal, ms (default 30000); a longer run keeps it by renewal. */
  ttl?: number;
}

/**
 * `@Cron` with exactly-once-per-tick across replicas: every replica's scheduler fires, the one that
 * sets the per-tick marker (`cron:<name>:<scheduled tick ms>`, never released) takes a try-once
 * renewed run lock and runs the job; the others log INFO and skip, as does a tick whose
 * predecessor is still running. An error in the job is logged (never thrown into the scheduler)
 * and the lock is released afterwards. The job starts in a fresh async context (no transaction).
 * The method gets the scheduler's stop signal as its only argument (`ScheduledRuns`: aborted when
 * the application stops, which waits for the run, bounded). The class must inject `lockService`
 * and `log`:
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
    // The scheduler's arguments (the cron library passes its onComplete) are not the job's
    const wrapped = async function (this: LockedJobHost) {
      assertLockedJobHost(this, "cron");
      // runLockedTick logs instead of throwing; this catch keeps the scheduler free of rejections
      await runLockedTick(this, {
        kind: "cron",
        name: options.name,
        lockKey,
        ttl: options.ttl ?? 30_000,
        tick: () => scheduledTick(expression, Date.now(), options.timeZone),
        run: (signal) => Promise.resolve(original.call(this, signal)),
      }).catch((err: unknown) => this.log?.error("cron job failed", { cron: options.name, err }));
    };
    Reflect.defineMetadata(LOCKED_JOB, true, wrapped);
    descriptor.value = wrapped;
    // The scheduler reads the metadata from the final method, so register after wrapping.
    Cron(expression, {
      name: options.name,
      ...(options.timeZone !== undefined && { timeZone: options.timeZone }),
    })(target, key, descriptor);
    return descriptor;
  };
}
