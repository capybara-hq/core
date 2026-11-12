import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Worker } from "bullmq";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { runJob } from "../infra/queue/run-job.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { CatalogModule } from "./catalog.module.js";
import {
  PLUGIN_SCOPE_CONCURRENCY,
  PLUGIN_SCOPE_QUEUE,
  PluginScopeSync,
  SCOPE_ITEM_JOB,
  SCOPE_ORG_JOB,
  type ScopeJob,
} from "./scope-sync.js";

/**
 * The consumer of {@link PLUGIN_SCOPE_QUEUE}: {@link PluginScopeSync} runs the `scope-item` and
 * `scope-org` jobs the outbox delivers (any other name fails the job).
 */
@Injectable()
export class PluginScopeSyncProcessor extends WorkerHost<Worker<ScopeJob>> {
  private readonly stopping = new AbortController();

  constructor(
    @Inject(PluginScopeSync) private readonly sync: PluginScopeSync,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "error">,
  ) {
    super();
  }

  process(job: Job<ScopeJob>): Promise<void> {
    return runJob(PLUGIN_SCOPE_QUEUE, job, () => {
      if (job.name !== SCOPE_ITEM_JOB && job.name !== SCOPE_ORG_JOB) {
        throw new Error(`unknown plugin scope job ${job.name}`);
      }
      return this.sync.process(job.data, this.stopping.signal);
    });
  }

  /** Starts consuming (worker role, after the extensions loaded; built with `autorun: false`). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  /** Stops between pairs and closes the worker. */
  async close(): Promise<void> {
    this.stopping.abort();
    await this.worker.close();
  }

  @OnWorkerEvent("failed")
  failed(job: Job<ScopeJob> | undefined, err: Error): void {
    this.log.error("plugin scope job failed", { name: job?.name, jobId: job?.id, err });
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("plugin scope worker error", { err });
  }
}

/**
 * The plugin scope queue's consumer: {@link PluginScopeSyncProcessor}. Imported only by the worker
 * role (`WorkerModule`), so other roles get no processor and no BullMQ worker. It never starts by
 * itself: the worker role (`WorkerRole`) starts it after the extensions loaded.
 */
@Module({
  imports: [CatalogModule],
  providers: [
    configuredProcessor(PluginScopeSyncProcessor, PLUGIN_SCOPE_QUEUE, {
      concurrency: PLUGIN_SCOPE_CONCURRENCY,
    }),
  ],
  exports: [PluginScopeSyncProcessor],
})
export class PluginScopeWorkersModule {}
