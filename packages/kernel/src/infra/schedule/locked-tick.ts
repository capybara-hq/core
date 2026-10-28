// The two layers of the kernel's locked jobs (the pattern locked-cron.decorator.ts packages),
// shared by @LockedCron and @LockedInterval.
import type { KernelLogger } from "../../log.js";
import { withLogContext } from "../../log-context.js";
import { runOutsideTransaction } from "../database/transaction-host.js";
import type { LockService } from "../lock/lock.service.js";

/** The properties a class with a `@LockedCron` / `@LockedInterval` job must inject. */
export interface LockedJobHost {
  lockService?: LockService;
  log?: KernelLogger;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The tick marker's lifetime: two periods, at least 10 s, at most a day. */
export const tickMarkerTtl = (periodMs: number): number =>
  Math.min(Math.max(periodMs * 2, 10_000), 24 * 3600_000);

/**
 * Runs one scheduled tick of a job exactly once across replicas, in two layers:
 * 1. one winner per tick: the replica that sets the per-tick marker `cron:<name>:<tick>` (never
 *    released, so a fast job on the winner does not let a slower replica run the same tick);
 * 2. a try-once renewed run lock (`lockKey`), so a long run never overlaps the next tick's run.
 * The others log INFO and skip. An error in the job is logged (never thrown into the scheduler)
 * and the lock is released afterwards. The job starts in a fresh async context (no transaction).
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
    run: () => Promise<unknown>;
  },
): Promise<void> {
  const { lockService, log } = host;
  const decorator = o.kind === "cron" ? "@LockedCron()" : "@LockedInterval()";
  if (!lockService || !log) {
    throw new Error(
      `${decorator} needs the class to inject \`LockService\` as \`lockService\` and the ` +
        "logger as `log`.",
    );
  }
  await runOutsideTransaction(() =>
    withLogContext({ cron: o.name }, async () => {
      let tick: number;
      try {
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
      } catch (err) {
        log.error("cron tick marker failed", { cron: o.name, err });
        return;
      }
      let handle: Awaited<ReturnType<LockService["acquire"]>>;
      try {
        handle = await lockService.acquire(o.lockKey, { ttlMs: o.ttl, waitMs: 0 });
      } catch (err) {
        log.error("cron lock failed", { cron: o.name, err });
        return;
      }
      if (!handle) {
        log.info("cron skipped: the previous run still holds the lock", { cron: o.name, tick });
        return;
      }
      try {
        await o.run();
      } catch (err) {
        log.error("cron job failed", { cron: o.name, error: errMsg(err), err });
      } finally {
        await handle.release();
      }
    }),
  );
}
