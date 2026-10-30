import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { SandboxService } from "./sandbox.service.js";

/** 空闲休眠扫描（每分钟，跨副本每个 tick 一次）。 */
export const SANDBOX_SUSPEND_JOB = "sandbox-suspend-idle";

/** 不活跃销毁扫描（每小时，跨副本每个 tick 一次）。 */
export const SANDBOX_DESTROY_JOB = "sandbox-destroy-inactive";

/** 一次性任务：立即销毁一批对话的沙箱（成员离职、删除 agent 后投递，数据 `{ conversationIds }`）。 */
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

  /** Enqueues the destruction of these conversations' sandboxes: a failed batch is retried whole (destroying one already destroyed does nothing). */
  async destroy(conversationIds: string[]): Promise<void> {
    await this.queue.add(
      SANDBOX_DESTROY_FOR_JOB,
      { conversationIds },
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
 * The worker side of {@link SANDBOX_DESTROY_FOR_JOB}: `destroyFor` one by one; a failure is warned
 * and fails the job (the whole batch is retried) after the others were destroyed.
 */
export async function runSandboxDestroyFor(
  sandbox: Pick<SandboxService, "destroyFor">,
  log: Pick<KernelLogger, "warn">,
  job: Pick<Job, "data">,
): Promise<void> {
  const ids = (job.data as { conversationIds?: unknown }).conversationIds;
  if (!Array.isArray(ids)) return;
  let failed = 0;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    try {
      await sandbox.destroyFor(id);
    } catch (err) {
      failed++;
      log.warn("cannot destroy sandbox of an offboarded member; will retry", {
        conversationId: id,
        err,
      });
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${ids.length} sandboxes could not be destroyed`);
}

/**
 * The sandbox sweeps (exactly once per tick across replicas): every minute the idle and overdue
 * running sandboxes are suspended, every hour the inactive ones and those of deleted orgs or
 * conversations are destroyed. Both do nothing without a sandbox provider. They replace the
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
