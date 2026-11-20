import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";

/** The daily prune's name (scheduler key and lock; no `:`). */
export const PUSH_STALE_JOB = "push-stale-registrations";

/** Registrations not seen for this many days are deleted. */
const STALE_DAYS = 60;
/** Rows per delete statement. */
const BATCH = 500;

/**
 * Deletes push registrations not seen for {@link STALE_DAYS} days (mobile app spec §9.3): the web
 * re-posts a registration on each app start, which refreshes `last_seen_at`, so an app unused that
 * long (or uninstalled without a sign-out) stops being pushed to. Once per tick across replicas
 * (`@LockedCron`, provided only under `WorkerModule`); no audit entry (`push.unregistered` is
 * written only for a person's removal). Nothing is kept between runs: a run stopped midway is
 * finished by the next one.
 */
@Injectable()
export class PushStaleJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("40 3 * * *", { name: PUSH_STALE_JOB })
  async sweep(signal?: AbortSignal): Promise<void> {
    const deleted = await this.prune(signal);
    if (deleted > 0) this.log.info("stale push registrations deleted", { deleted });
  }

  /**
   * One prune without the tick lock (the cron body; tests call it directly): deletes in batches
   * of {@link BATCH} until none is left or `signal` aborts; returns how many it deleted.
   */
  async prune(signal?: AbortSignal): Promise<number> {
    let deleted = 0;
    while (!signal?.aborted) {
      const r = await this.db.db
        .deleteFrom("push_registrations")
        .where("id", "in", (eb) =>
          eb
            .selectFrom("push_registrations")
            .select("id")
            .where("last_seen_at", "<", sql<Date>`now() - make_interval(days => ${STALE_DAYS})`)
            .limit(BATCH),
        )
        .executeTakeFirst();
      const n = Number(r.numDeletedRows);
      deleted += n;
      if (n < BATCH) break;
    }
    return deleted;
  }
}
