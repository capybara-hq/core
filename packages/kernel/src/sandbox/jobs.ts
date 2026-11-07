import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { SandboxService } from "./sandbox.service.js";

/** The idle suspension sweep (every minute, once per tick across replicas). */
export const SANDBOX_SUSPEND_JOB = "sandbox-suspend-idle";

/** The inactivity destruction sweep (hourly, once per tick across replicas). */
export const SANDBOX_DESTROY_JOB = "sandbox-destroy-inactive";

/**
 * One-off job: destroy a batch of environments now, instance and file system (environment
 * deletion, offboarding; data `{ environmentIds }`).
 */
export const SANDBOX_DESTROY_FOR_JOB = "sandbox-destroy-for";

/**
 * The producer of {@link SANDBOX_DESTROY_FOR_JOB} on the maintenance queue (BullMQ's own job ids, as
 * before: every enqueue is a new job, also after a batch failed all its attempts); `MaintenanceProcessor`
 * consumes it.
 */
@Injectable()
export class SandboxJobs {
  constructor(
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) private readonly queue: Pick<Queue, "add">,
  ) {}

  /**
   * Enqueues the destruction of these environments: a failed batch is retried whole (destroying
   * one already destroyed does nothing).
   */
  async destroy(environmentIds: string[]): Promise<void> {
    await this.queue.add(
      SANDBOX_DESTROY_FOR_JOB,
      { environmentIds },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}

/**
 * The worker side of {@link SANDBOX_DESTROY_FOR_JOB}: `destroyEnvironment` one by one; a failure is
 * warned and fails the job (the whole batch is retried) after the others were destroyed.
 */
export async function runSandboxDestroyFor(
  sandbox: Pick<SandboxService, "destroyEnvironment">,
  log: Pick<KernelLogger, "warn">,
  job: Pick<Job, "data">,
): Promise<void> {
  const ids = (job.data as { environmentIds?: unknown }).environmentIds;
  if (!Array.isArray(ids)) return;
  let failed = 0;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    try {
      await sandbox.destroyEnvironment(id);
    } catch (err) {
      failed++;
      log.warn("cannot destroy environment; will retry", { environmentId: id, err });
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${ids.length} environments could not be destroyed`);
}

/**
 * The sandbox sweeps (exactly once per tick across replicas): every minute the idle and overdue
 * running instances are suspended, every hour the inactive instances are destroyed (files kept)
 * and deleted environments, or those of deleted orgs, are destroyed with their files. Both do nothing without a sandbox provider. They replace the
 * maintenance schedulers `sandbox-suspend-idle-every-minute` and `sandbox-destroy-inactive-hourly`
 * (retired at worker start).
 */
@Injectable()
export class SandboxSweepJobs {
  constructor(
    @Inject(SandboxService)
    private readonly sandbox: Pick<SandboxService, "suspendIdle" | "destroyInactive">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("* * * * *", { name: SANDBOX_SUSPEND_JOB })
  async suspendIdle(): Promise<void> {
    const n = await this.sandbox.suspendIdle(new Date());
    if (n > 0) this.log.info("idle sandboxes suspended", { count: n });
  }

  @LockedCron("0 * * * *", { name: SANDBOX_DESTROY_JOB })
  async destroyInactive(): Promise<void> {
    const n = await this.sandbox.destroyInactive(new Date());
    if (n > 0) this.log.info("inactive sandboxes destroyed", { count: n });
  }
}
