import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { deleteExpiredInitialPasswords } from "./initial-passwords.js";

/** The hourly cleanup of expired sealed initial passwords (`@LockedCron`). */
export const INITIAL_PASSWORD_CLEANUP_JOB = "initial-password-cleanup";

/**
 * Deletes generated initial passwords nobody read before they expired (Platform tool spec §14.5
 * item 2), once per tick across replicas; the worker role's.
 */
@Injectable()
export class InitialPasswordCleanupJob {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("20 * * * *", { name: INITIAL_PASSWORD_CLEANUP_JOB })
  async cleanup(): Promise<void> {
    const n = await deleteExpiredInitialPasswords(this.db.db);
    if (n > 0) this.log.info("expired initial passwords deleted", { count: n });
  }
}
