import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MARKETPLACES_REFRESH_JOB, PLUGIN_STAGING_CLEANUP_JOB } from "./job-ids.js";
import { MARKETPLACES_REFRESH_DEADLINE_MS, MarketplacesService } from "./marketplaces.service.js";
import { PluginImport } from "./plugin-import.js";

/**
 * The catalog's periodic jobs, each run once per tick across replicas: the marketplace refresh
 * (`catalogs-refresh`, every `marketplaces.refreshIntervalMinutes` and once after the start:
 * `@LockedInterval` with `runOnStart`) and the
 * hourly cleanup of expired plugin import staging (`app-staging-cleanup`: `@LockedCron`).
 */
@Injectable()
export class CatalogJobs {
  constructor(
    @Inject(MarketplacesService) private readonly marketplaces: MarketplacesService,
    @Inject(PluginImport) private readonly imports: PluginImport,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  /**
   * Refreshes every enabled marketplace in turn (overall deadline
   * {@link MARKETPLACES_REFRESH_DEADLINE_MS}; the job's signal aborts it: the stop, or the run
   * lock lost).
   */
  @LockedInterval(
    MARKETPLACES_REFRESH_JOB,
    (c) => c.marketplaces.refreshIntervalMinutes * 60_000,
    // a fresh deployment's marketplaces are refreshed right after the start
    { runOnStart: true },
  )
  async refreshMarketplaces(stop?: AbortSignal): Promise<void> {
    const deadline = AbortSignal.timeout(MARKETPLACES_REFRESH_DEADLINE_MS);
    await this.marketplaces.refreshAll(stop ? AbortSignal.any([deadline, stop]) : deadline);
  }

  /** Deletes expired staging rows and their objects. */
  @LockedCron("0 * * * *", { name: PLUGIN_STAGING_CLEANUP_JOB })
  async cleanupStaging(): Promise<void> {
    const n = await this.imports.cleanupExpired();
    if (n > 0) this.log.info("expired plugin imports cleaned up", { count: n });
  }
}
