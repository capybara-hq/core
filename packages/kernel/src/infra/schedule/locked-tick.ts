// The two layers of the kernel's locked jobs (the pattern locked-cron.decorator.ts packages),
// shared by @LockedCron and @LockedInterval.
import type { KernelLogger } from "../../log.js";
import { withLogContext } from "../../log-context.js";
import { runOutsideTransaction } from "../database/transaction-host.js";
import type { LockService } from "../lock/lock.service.js";

/** Marks a method wrapped by `@LockedCron` / `@LockedInterval` (read by `ScheduledRuns`). */
export const LOCKED_JOB = Symbol("LOCKED_JOB");

/**
 * The job's name and its undecorated body, on the wrapped method: `ScheduledRuns.runNow` runs the
 * body once outside the schedule.
 */
export const LOCKED_JOB_BODY = Symbol("LOCKED_JOB_BODY");

/** What {@link LOCKED_JOB_BODY} holds. */
export interface LockedJobBody {
  name: string;
  body: (signal?: AbortSignal) => unknown;
}

/** The property `ScheduledRuns` attaches itself under on every instance with a locked job. */
export const SCHEDULED_RUNS = Symbol("SCHEDULED_RUNS");

/** The properties a class with a `@LockedCron` / `@LockedInterval` job must inject. */
export interface LockedJobHost {
  lockService?: LockService;
  log?: KernelLogger;
  /** Attached by `ScheduledRuns` at module init (absent outside a Nest application). */
  [SCHEDULED_RUNS]?: ScheduledRunScope;
}

/** What a locked job's run sees of `ScheduledRuns`: the stop state, the signal and the tracking. */
export interface ScheduledRunScope {
  /**
   * The start gate (R21): false until the role that runs the jobs opened it (the kernel's worker
   * role, after the extension load) and again once the stop began; no run starts while it is shut.
   */
  readonly opened: boolean;
  /** True once the stop began: no new run starts. */
  readonly stopped: boolean;
  /** Aborted when the stop begins; the job method's argument aborts with it. */
  readonly signal: AbortSignal;
  /** Registers a run the stop waits for (bounded); returns `p`. */
  track<T>(p: Promise<T>): Promise<T>;
}

/**
 * Throws when the class lacks `lockService` / `log` (a programming error, so the decorated call
 * rejects); everything after this check is logged, never thrown.
 */
export function assertLockedJobHost(host: LockedJobHost, kind: "cron" | "interval"): void {
  if (!host.lockService || !host.log) {
    const decorator = kind === "cron" ? "@LockedCron()" : "@LockedInterval()";
    throw new Error(
      `${decorator} needs the class to inject \`LockService\` as \`lockService\` and the ` +
        "logger as `log`.",
    );
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The tick marker's lifetime: two periods, at least 10 s, at most a day. */
export const tickMarkerTtl = (periodMs: number): number =>
  Math.min(Math.max(periodMs * 2, 10_000), 24 * 3600_000);

/**
 * The start marker's lifetime: replicas that start within this window (one period, at most a
 * minute) run a `runOnStart` job once; a replica restarted after it runs it again, like the first
 * run of a newly created repeatable scheduler.
 */
export const startMarkerTtl = (periodMs: number): number => Math.min(periodMs, 60_000);

/**
 * Runs one scheduled tick of a job exactly once across replicas, in two layers:
 * 1. one winner per tick: the replica that sets the per-tick marker `cron:<name>:<tick>` (never
 *    released, so a fast job on the winner does not let a slower replica run the same tick);
 * 2. a try-once renewed run lock (`lockKey`), so a long run never overlaps the next tick's run.
 * The others log INFO and skip. An error in the job is logged (never thrown into the scheduler)
 * and the lock is released afterwards. The job starts in a fresh async context (no transaction).
 *
 * Inside a Nest application the run is tracked by `ScheduledRuns` (the stop aborts the signal the
 * job gets and waits for the run, bounded) and no run starts before `ScheduledRuns.open()` (R21:
 * the timers are armed at application bootstrap, before the kernel's start sequence) or once the
 * stop began; failures caused
 * by the stop (an aborted job, a lock release after Redis closed) are logged at WARN / INFO. Only
 * the host check rejects (see {@link assertLockedJobHost}).
 */
export async function runLockedTick(
  host: LockedJobHost,
  o: {
    kind: "cron" | "interval";
    name: string;
    lockKey: string;
    ttl: number;
    /** The tick (epoch ms) and the period it belongs to; thrown errors are logged as marker failures. */
    tick: () => { tick: number; periodMs: number };
    /**
     * A start run (`@LockedInterval({ runOnStart })`) instead of a tick: the first layer is the
     * start marker `cron:<name>:start` for `ttlMs` (see {@link startMarkerTtl}).
     */
    start?: { ttlMs: number };
    /**
     * The job body; `signal` aborts when the stop begins (`ScheduledRuns`) or the run lock is lost.
     */
    run: (signal: AbortSignal) => Promise<unknown>;
  },
): Promise<void> {
  assertLockedJobHost(host, o.kind);
  const lockService = host.lockService as LockService;
  const log = host.log as KernelLogger;
  const scope = host[SCHEDULED_RUNS];
  if (scope?.stopped) {
    log.info("cron skipped: the scheduler is stopping", { cron: o.name });
    return;
  }
  if (scope && !scope.opened) {
    // R21: a tick before the start sequence reached the jobs (migrations, bootstrap, extensions)
    log.info("cron skipped: the scheduler is not started", { cron: o.name });
    return;
  }
  const signal = scope?.signal;
  /** Errors during the stop are expected (the job aborted, Redis closing): WARN, not ERROR. */
  const logFailure = (msg: string, fields: Record<string, unknown>) =>
    signal?.aborted ? log.warn(msg, fields) : log.error(msg, fields);
  const run = runOutsideTransaction(() =>
    withLogContext({ cron: o.name }, async () => {
      let tick: number | "start";
      try {
        if (o.start) {
          tick = "start";
          if (!(await lockService.lease(`cron:${o.name}:start`, "start", o.start.ttlMs))) {
            log.info("cron skipped: start run already taken by another replica", { cron: o.name });
            return;
          }
        } else {
          const t = o.tick();
          tick = t.tick;
          if (
            !(await lockService.lease(`cron:${o.name}:${tick}`, "tick", tickMarkerTtl(t.periodMs)))
          ) {
            log.info("cron skipped: tick already taken by another replica", {
              cron: o.name,
              tick,
            });
            return;
          }
        }
      } catch (err) {
        logFailure("cron tick marker failed", { cron: o.name, err });
        return;
      }
      let handle: Awaited<ReturnType<LockService["acquire"]>>;
      try {
        handle = await lockService.acquire(o.lockKey, { ttlMs: o.ttl, waitMs: 0 });
      } catch (err) {
        logFailure("cron lock failed", { cron: o.name, err });
        return;
      }
      if (!handle) {
        log.info("cron skipped: the previous run still holds the lock", { cron: o.name, tick });
        return;
      }
      try {
        if (signal?.aborted) {
          log.info("cron skipped: the scheduler is stopping", { cron: o.name, tick });
        } else {
          // the job stops on the stop signal and when its run lock is lost (another replica may
          // take the lock and start the next run)
          await o.run(signal ? AbortSignal.any([signal, handle.lost]) : handle.lost);
        }
      } catch (err) {
        if (signal?.aborted) {
          log.info("cron run stopped by the shutdown", { cron: o.name, error: errMsg(err) });
        } else if (handle.lost.aborted) {
          log.warn("cron run stopped: its run lock was lost", { cron: o.name, error: errMsg(err) });
        } else {
          log.error("cron job failed", { cron: o.name, error: errMsg(err), err });
        }
      } finally {
        await handle
          .release()
          .catch((err: unknown) => logFailure("cron lock release failed", { cron: o.name, err }));
      }
    }),
  );
  try {
    await (scope ? scope.track(run) : run);
  } catch (err) {
    // runOutsideTransaction / withLogContext themselves; never into the scheduler
    logFailure("cron run failed", { cron: o.name, err });
  }
}
