import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import { type Job, UnrecoverableError, type Worker } from "bullmq";
import { runJob } from "../infra/queue/run-job.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  CONNECTOR_TOOLS_JOB,
  CONNECTOR_TOOLS_QUEUE,
  type ConnectorToolsJobData,
} from "./connector-tools-jobs.js";
import { ConnectorsService } from "./connectors.service.js";
import { ToolsModule } from "./tools.module.js";

/**
 * The consumer of {@link CONNECTOR_TOOLS_QUEUE} (`cap-connector-tools`): each
 * `connector-tools-list` job lists one connector's tools through
 * `ConnectorsService.listToolsForJob` (the refresh path's listing and compare-and-write), inside
 * `runJob`. Worker role only (`ConnectorToolsWorkersModule`); built with `autorun: false` and
 * started by the worker role after the extensions loaded, so a connector extension is there to
 * list with. A failed attempt is retried by the queue (registry `opts`); the last one logs an
 * error with ids only.
 */
@Injectable()
@Processor(CONNECTOR_TOOLS_QUEUE, { autorun: false })
export class ConnectorToolsProcessor extends WorkerHost<Worker<ConnectorToolsJobData>> {
  constructor(
    @Inject(ConnectorsService)
    private readonly connectors: Pick<ConnectorsService, "listToolsForJob">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {
    super();
  }

  process(job: Job<ConnectorToolsJobData>): Promise<unknown> {
    return runJob(CONNECTOR_TOOLS_QUEUE, job, async () => {
      if (job.name !== CONNECTOR_TOOLS_JOB) {
        throw new UnrecoverableError(`unknown connector tools job ${job.name}`);
      }
      return this.connectors.listToolsForJob(job.data);
    });
  }

  /** Starts consuming (worker role, after the extensions loaded). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  /** Closes the worker, waiting for the listings in flight (each bounded by the tool timeout). */
  async close(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent("failed")
  failed(job: Job<ConnectorToolsJobData> | undefined, err: Error): void {
    if (!job) return;
    const fields = {
      jobId: job.id,
      orgId: job.data.orgId,
      connectorId: job.data.connectorId,
      attempt: job.attemptsMade,
      error: err.message,
    };
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      this.log.error("connector tool listing failed on its last attempt; given up", fields);
    } else this.log.warn("connector tool listing failed; retrying", fields);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("connector tools worker error", { err });
  }
}

/**
 * The connector tools queue's consumer; imported only by the worker role (`WorkerModule`). The
 * queue itself is registered by `ToolsModule` (every role owes the jobs).
 */
@Module({
  imports: [ToolsModule],
  providers: [ConnectorToolsProcessor],
  exports: [ConnectorToolsProcessor],
})
export class ConnectorToolsWorkersModule {}
