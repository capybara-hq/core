import { hostname } from "node:os";
import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { type DynamicModule, Inject, Injectable, Module } from "@nestjs/common";
import { type Job, UnrecoverableError, type Worker } from "bullmq";
import type { KernelConfig } from "../config/schema.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { runJob } from "../infra/queue/run-job.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ToolWatchService } from "./tool-watch.service.js";
import { TOOL_WATCH_JOB, TOOL_WATCH_QUEUE, type ToolWatchJobData } from "./tool-watch-queue.js";
import { ToolsModule } from "./tools.module.js";

/**
 * The consumer of {@link TOOL_WATCH_QUEUE} (`cap-kernel-tool-watch`, its own worker so a slow
 * device never delays the maintenance queue): each `tool-watch` job polls one watched question's
 * watcher through {@link ToolWatchService}, inside `runJob` with the job's org scope.
 * Concurrency `tools.watchConcurrency` (polls are I/O-bound). Worker role only
 * (`ToolWatchWorkersModule`); built with `autorun: false` and started by the worker role after the
 * extensions loaded, so the watchers are registered.
 */
@Injectable()
export class ToolWatchProcessor extends WorkerHost<Worker<ToolWatchJobData>> {
  constructor(
    @Inject(ToolWatchService) private readonly watch: ToolWatchService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {
    super();
  }

  process(job: Job<ToolWatchJobData>, token?: string): Promise<void> {
    return runJob(TOOL_WATCH_QUEUE, job, async () => {
      if (job.name !== TOOL_WATCH_JOB) {
        throw new UnrecoverableError(`unknown tool watch job ${job.name}`);
      }
      await this.watch.process(job, token);
    });
  }

  /** Starts consuming (worker role, after the extensions loaded). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  /** Closes the worker, waiting for the polls in flight (each bounded by the watcher timeout). */
  async close(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent("failed")
  failed(job: Job<ToolWatchJobData> | undefined, err: Error): void {
    if (!job) return;
    const fields = {
      jobId: job.id,
      orgId: job.data.orgId,
      questionId: job.data.questionId,
      attempt: job.attemptsMade,
      error: err.message,
    };
    // the question stays pending: its deadline (the wait-timeout job) still ends it
    if (job.attemptsMade >= (job.opts.attempts ?? 1))
      this.log.error(
        "tool watch poll failed on its last attempt; the wait ends at its deadline",
        fields,
      );
    else this.log.warn("tool watch poll failed; retrying", fields);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("tool watch worker error", { err });
  }
}

/**
 * The watched-wait poll queue's consumer; imported only by the worker role (`WorkerModule`). The
 * queue itself is registered by `ToolWatchQueueModule` (through `ToolsModule`: every role owes the
 * first poll with a watched ask).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class ToolWatchWorkersModule {
  static forRoot(config: KernelConfig): DynamicModule {
    return {
      module: ToolWatchWorkersModule,
      imports: [ToolsModule, ExtensionsModule],
      providers: [
        ToolWatchService,
        configuredProcessor(ToolWatchProcessor, TOOL_WATCH_QUEUE, {
          // the worker name is recorded on the job (BullMQ processedBy): which replica ran it
          name: `${hostname()}-${process.pid}`,
          concurrency: config.tools.watchConcurrency,
          // a crash during a poll is a stall: the poll runs again, however often over a long wait
          maxStalledCount: 1_000,
        }),
      ],
      exports: [ToolWatchProcessor],
    };
  }
}
