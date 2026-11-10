import { Inject, Injectable } from "@nestjs/common";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ClientReports } from "./client-reports.service.js";

/** The daily prune of client reports (`@LockedCron`). */
export const CLIENT_REPORTS_PRUNE_JOB = "client-reports-prune";

/** Deletes client reports not seen for 30 days (spec §10.4), once per tick across replicas; the worker role's. */
@Injectable()
export class ClientReportsCron {
  constructor(
    @Inject(ClientReports) private readonly reports: ClientReports,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("50 3 * * *", { name: CLIENT_REPORTS_PRUNE_JOB })
  async prune(): Promise<void> {
    const n = await this.reports.prune();
    if (n > 0) this.log.info("client reports pruned", { count: n });
  }
}
