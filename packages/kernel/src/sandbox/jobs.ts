import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { LockService } from "../infra/lock/lock.service.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
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
 * One-off job: destroy devices now, instance and file system (data `{ deviceIds }`). Owed through
 * the outbox by the transaction that soft-deletes the device (a device's deletion, offboarding),
 * one device per job under {@link deviceDestroyJobId} ({@link oweDeviceDestroy}).
 */
export const SANDBOX_DESTROY_FOR_JOB = "sandbox-destroy-for";

/** The data of a {@link SANDBOX_DESTROY_FOR_JOB} job. */
export interface SandboxDestroyForData {
  deviceIds: string[];
}

/**
 * The deterministic id of a deleted device's destroy job (no `:`): a device is deleted once, so
 * its destruction is owed once.
 */
export const deviceDestroyJobId = (deviceId: string): string => `device-destroy-${deviceId}`;

/**
 * Owes the destruction of a device in the caller's transaction, the one that soft-deleted it
 * (transactional outbox spec §8.1; throws outside a transaction).
 */
export function oweDeviceDestroy(
  outbox: Pick<OutboxService, "add">,
  deviceId: string,
  orgId: string,
): Promise<boolean> {
  return outbox.add<SandboxDestroyForData>({
    queue: MAINTENANCE_QUEUE_NAME,
    name: SANDBOX_DESTROY_FOR_JOB,
    jobId: deviceDestroyJobId(deviceId),
    data: { deviceIds: [deviceId] },
    orgId,
  });
}

/**
 * One-off job: start a device over with empty files (`resetFileSystem`; data
 * `{ deviceId }`, job id {@link resetFilesJobId}).
 */
export const SANDBOX_RESET_FILES_JOB = "sandbox-reset-files";

/**
 * The deterministic id of a device's reset job: a second request while one is waiting or
 * running joins it (that reset still empties the files); once it ended, a new request is a new job.
 */
export const resetFilesJobId = (deviceId: string): string =>
  `${SANDBOX_RESET_FILES_JOB}-${deviceId}`;

/**
 * The producer of {@link SANDBOX_RESET_FILES_JOB} (destroys are owed through the outbox,
 * {@link oweDeviceDestroy}); `MaintenanceProcessor` consumes both.
 */
@Injectable()
export class SandboxJobs {
  constructor(
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) private readonly queue: Pick<Queue, "add">,
  ) {}

  /**
   * Enqueues the reset of a device's files (see {@link resetFilesJobId}): retried on failure
   * (the exclusive lease not obtained in time, the provider failing); a job that failed all its
   * attempts is removed, so the id never blocks a later request.
   */
  async resetFiles(deviceId: string): Promise<void> {
    await this.queue.add(
      SANDBOX_RESET_FILES_JOB,
      { deviceId },
      {
        jobId: resetFilesJobId(deviceId),
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }
}

/**
 * The worker side of {@link SANDBOX_RESET_FILES_JOB}: `resetFileSystem` under the exclusive lease;
 * a failure fails the job (retried).
 */
export async function runSandboxResetFiles(
  sandbox: Pick<SandboxService, "resetFileSystem">,
  job: Pick<Job, "data">,
): Promise<void> {
  const id = (job.data as { deviceId?: unknown }).deviceId;
  if (typeof id !== "string") return;
  await sandbox.resetFileSystem(id);
}

/**
 * The worker side of {@link SANDBOX_DESTROY_FOR_JOB}: `destroyDevice` one by one; a failure is
 * warned and fails the job (the whole batch is retried) after the others were destroyed.
 */
export async function runSandboxDestroyFor(
  sandbox: Pick<SandboxService, "destroyDevice">,
  log: Pick<KernelLogger, "warn">,
  job: Pick<Job, "data">,
): Promise<void> {
  const ids = (job.data as { deviceIds?: unknown }).deviceIds;
  if (!Array.isArray(ids)) return;
  let failed = 0;
  for (const id of ids) {
    if (typeof id !== "string") continue;
    try {
      await sandbox.destroyDevice(id);
    } catch (err) {
      failed++;
      log.warn("cannot destroy device; will retry", { deviceId: id, err });
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${ids.length} devices could not be destroyed`);
}

/**
 * The sandbox sweeps (exactly once per tick across replicas): every minute the idle and overdue
 * running instances are suspended, every hour the inactive instances are destroyed (files kept)
 * and deleted devices, or those of deleted orgs, are destroyed with their files. Both do nothing without a sandbox provider. They replace the
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
