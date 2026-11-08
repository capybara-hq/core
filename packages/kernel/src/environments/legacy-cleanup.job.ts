import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { SandboxProviders } from "../sandbox/providers.js";

/** The job's name (`@LockedInterval`, run lock `cron:environments-legacy-cleanup`). */
export const LEGACY_CLEANUP_JOB = "environments-legacy-cleanup";

/** Every 5 minutes, once per tick across replicas. */
const PERIOD_MS = 5 * 60_000;

/** Rows handled per tick. */
const BATCH = 50;

/** The time limit of one provider call. */
const CALL_TIMEOUT_MS = 120_000;

/** What one run did: rows destroyed and deleted, rows kept because their provider is not loaded. */
export interface LegacyCleanupResult {
  destroyed: number;
  kept: number;
}

/**
 * The cleanup of the per-conversation sandboxes of before environments (spec
 * 2026-11-07-environments-design §4.2 item 9): for up to {@link BATCH} rows of the legacy
 * `sandboxes` table per tick, the row's provider destroys the instance and the file system named
 * `cap-<conversationId>` (`destroyByName`, `destroyFileSystemByName`; also the instance of the
 * provider it replaced, `prev_provider`, when that one is loaded), then the row is deleted. No
 * lease is taken: nothing holds a legacy row after the upgrade. A row whose provider is not loaded
 * is kept (warned once per hour: on the tick in the first {@link PERIOD_MS} of each hour); a row
 * whose destruction failed is retried at a later tick, after the others (`sweep_failed_at`). With
 * no rows left a tick is one `SELECT … LIMIT 1`. The table is dropped by a later migration.
 */
@Injectable()
export class LegacySandboxCleanupJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(SandboxProviders) private readonly providers: Pick<SandboxProviders, "forName">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedInterval(LEGACY_CLEANUP_JOB, () => PERIOD_MS, { ttl: CALL_TIMEOUT_MS })
  async tick(signal?: AbortSignal): Promise<void> {
    const res = await this.runOnce(new Date(), signal);
    if (res.destroyed > 0) this.log.info("legacy sandboxes destroyed", { ...res });
  }

  /** One run (see the class); `signal` (the stop, or a lost run lock) is read between rows. */
  async runOnce(now = new Date(), signal?: AbortSignal): Promise<LegacyCleanupResult> {
    const any = await this.db
      .selectFrom("sandboxes")
      .select("conversation_id")
      .limit(1)
      .executeTakeFirst();
    if (any === undefined) return { destroyed: 0, kept: 0 };

    const byProvider = await this.db
      .selectFrom("sandboxes")
      .select(["provider", (eb) => eb.fn.countAll<string>().as("n")])
      .groupBy("provider")
      .execute();
    const loaded = byProvider.filter((p) => this.providers.forName(p.provider) !== undefined);
    const unloaded = byProvider.filter((p) => this.providers.forName(p.provider) === undefined);
    const kept = unloaded.reduce((sum, p) => sum + Number(p.n), 0);
    if (unloaded.length > 0 && now.getTime() % 3_600_000 < PERIOD_MS) {
      this.log.warn("legacy sandboxes kept: their provider is not loaded", {
        providers: unloaded.map((p) => p.provider),
        count: kept,
      });
    }
    if (loaded.length === 0) return { destroyed: 0, kept };

    const rows = await this.db
      .selectFrom("sandboxes")
      .select(["conversation_id", "provider", "prev_provider"])
      .where(
        "provider",
        "in",
        loaded.map((p) => p.provider),
      )
      .orderBy("sweep_failed_at", (o) => o.asc().nullsFirst())
      .orderBy("conversation_id")
      .limit(BATCH)
      .execute();

    let destroyed = 0;
    for (const row of rows) {
      if (signal?.aborted) break;
      const name = `cap-${row.conversation_id}`;
      const impl = this.providers.forName(row.provider)?.impl;
      if (impl === undefined) continue; // unloaded since the query: kept for a later tick
      const callSignal = () =>
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)])
          : AbortSignal.timeout(CALL_TIMEOUT_MS);
      try {
        await impl.destroyByName(name, callSignal());
        await impl.destroyFileSystemByName(name, callSignal());
        if (row.prev_provider !== null && row.prev_provider !== row.provider) {
          const prev = this.providers.forName(row.prev_provider)?.impl;
          if (prev !== undefined) await prev.destroyByName(name, callSignal());
          else {
            this.log.warn("legacy sandbox of a replaced provider left: provider not loaded", {
              name,
              provider: row.prev_provider,
            });
          }
        }
        await this.db
          .deleteFrom("sandboxes")
          .where("conversation_id", "=", row.conversation_id)
          .execute();
        destroyed++;
      } catch (err) {
        this.log.warn("cannot destroy legacy sandbox; will retry", { name, err });
        await this.db
          .updateTable("sandboxes")
          .set({ sweep_failed_at: now })
          .where("conversation_id", "=", row.conversation_id)
          .execute();
      }
    }
    return { destroyed, kept };
  }
}
