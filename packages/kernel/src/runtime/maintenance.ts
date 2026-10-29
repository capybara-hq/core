import { getQueueToken, OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { type DynamicModule, Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Queue, Worker } from "bullmq";
import type { KernelConfig } from "../config/schema.js";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { removeRetiredSchedulers } from "../infra/queue/retired-schedulers.js";
import { runJob } from "../infra/queue/run-job.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { DIRECTORY_SYNC_JOB, DirectorySync, type SyncJobData } from "../orgs/directory-sync.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { runSandboxDestroyFor, SANDBOX_DESTROY_FOR_JOB } from "../sandbox/jobs.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import { type DriftConnectorJobData, ToolDrift } from "../tools/drift.js";
import { DRIFT_CONNECTOR_JOB } from "../tools/job-ids.js";
import { ToolsModule } from "../tools/tools.module.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { RETIRED_SCHEDULER_IDS } from "./retired-schedulers.js";
import { RuntimeModule } from "./runtime.module.js";
import { WAIT_TIMEOUT_JOB, Waits, type WaitTimeoutData } from "./waits.js";

export { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";

/** The maintenance worker's concurrency (as the hand-made worker had). */
export const MAINTENANCE_CONCURRENCY = 5;

/**
 * The one consumer of `cap-kernel-maintenance` (ruling R11): dispatches each one-off job by name
 * to its domain (`wait-timeout` → {@link Waits}, `sandbox-destroy-for` → {@link SandboxService},
 * `drift-connector` → {@link ToolDrift}, `directory-sync` → {@link DirectorySync}); an unknown
 * name is warned and completes. The producers are the domains' own (same names, ids and options).
 */
@Injectable()
export class MaintenanceProcessor extends WorkerHost<Worker> {
  constructor(
    @Inject(Waits) private readonly waits: Pick<Waits, "processTimeout">,
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "destroyFor">,
    @Inject(ToolDrift) private readonly drift: Pick<ToolDrift, "check">,
    @Inject(DirectorySync) private readonly directory: Pick<DirectorySync, "runSyncJob">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "error" | "warn">,
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME))
    private readonly queue: Pick<Queue, "removeJobScheduler">,
  ) {
    super();
  }

  /**
   * Removes the retired job schedulers (`RETIRED_SCHEDULER_IDS`, runtime/retired-schedulers.ts): every fixed-period
   * maintenance job is a `@LockedCron` / `@LockedInterval` now. Idempotent; called once when a
   * worker role starts.
   */
  removeRetiredSchedulers(): Promise<void> {
    return removeRetiredSchedulers(this.queue, RETIRED_SCHEDULER_IDS);
  }

  process(job: Job, token?: string): Promise<void> {
    return runJob(MAINTENANCE_QUEUE_NAME, job, () => this.dispatch(job, token));
  }

  /** Starts consuming (worker role, after the extensions loaded; built with `autorun: false`). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  private async dispatch(job: Job, token: string | undefined): Promise<void> {
    switch (job.name) {
      case WAIT_TIMEOUT_JOB:
        await this.waits.processTimeout(job as Job<WaitTimeoutData>, token);
        return;
      case SANDBOX_DESTROY_FOR_JOB:
        await runSandboxDestroyFor(this.sandbox, this.log, job);
        return;
      case DRIFT_CONNECTOR_JOB: {
        const { orgId, connectorId, trigger } = job.data as DriftConnectorJobData;
        await this.drift.check(orgId, connectorId, trigger);
        return;
      }
      case DIRECTORY_SYNC_JOB:
        await this.directory.runSyncJob(job.data as SyncJobData);
        return;
      default:
        this.log.warn("unknown maintenance job", { name: job.name, jobId: job.id });
    }
  }

  @OnWorkerEvent("failed")
  failed(job: Job | undefined, err: Error): void {
    this.log.error("maintenance job failed", { name: job?.name, jobId: job?.id, err });
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("maintenance worker error", { err });
  }
}

/**
 * The maintenance queue's consumer, on the `worker` role only (other roles get no processor, so
 * no BullMQ worker): {@link MaintenanceProcessor}. It never starts by itself: `KernelLifecycle`
 * removes the retired job schedulers and starts it after the extensions loaded.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class MaintenanceModule {
  static forRoot(config: Pick<KernelConfig, "roles">): DynamicModule {
    const consumes = config.roles.includes("worker");
    return {
      module: MaintenanceModule,
      imports: [
        RuntimeModule,
        SandboxModule,
        ToolsModule,
        OrgsModule,
        QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
      ],
      providers: consumes
        ? [
            configuredProcessor(MaintenanceProcessor, MAINTENANCE_QUEUE_NAME, {
              concurrency: MAINTENANCE_CONCURRENCY,
            }),
          ]
        : [],
      exports: consumes ? [MaintenanceProcessor] : [],
    };
  }
}
