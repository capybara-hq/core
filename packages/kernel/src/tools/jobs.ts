import { Inject, Injectable } from "@nestjs/common";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ToolDrift } from "./drift.js";
import { DRIFT_SCAN_JOB, OUTPUT_CLEANUP_JOB } from "./job-ids.js";
import { deleteExpiredOutputs } from "./outputs.js";

/**
 * The tools' periodic jobs, each run once per tick across replicas: the tool drift scan
 * (`drift-scan`, every `tools.driftIntervalHours` and once right after the start, as the old
 * repeatable scheduler's first run: `@LockedInterval` with `runOnStart`; a repeated scan in the
 * same period enqueues nothing new, its job ids are per period) and the hourly cleanup of expired
 * tool output archives (`output-cleanup`: `@LockedCron`).
 */
@Injectable()
export class ToolJobs {
  constructor(
    @Inject(ToolDrift) private readonly drift: Pick<ToolDrift, "scan">,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  /** Enqueues a drift check of every active connector not checked in this period. */
  @LockedInterval(DRIFT_SCAN_JOB, (c) => c.tools.driftIntervalHours * 3_600_000, {
    runOnStart: true,
  })
  async scanDrift(): Promise<void> {
    const n = await this.drift.scan();
    if (n > 0) this.log.info("tool drift checks enqueued", { count: n });
  }

  /** Deletes expired tool output archives (in batches, no long transaction). */
  @LockedCron("0 * * * *", { name: OUTPUT_CLEANUP_JOB })
  async cleanupOutputs(): Promise<void> {
    const n = await deleteExpiredOutputs(this.db.db);
    if (n > 0) this.log.info("expired tool outputs deleted", { count: n });
  }
}
