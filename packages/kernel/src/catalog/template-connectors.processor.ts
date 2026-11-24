import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import { type Job, UnrecoverableError, type Worker } from "bullmq";
import { runJob } from "../infra/queue/run-job.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { CatalogModule } from "./catalog.module.js";
import { TemplateConnectorEnsurer } from "./template-connector-ensure.js";
import {
  TEMPLATE_CONNECTORS_JOB,
  TEMPLATE_CONNECTORS_QUEUE,
  type TemplateConnectorsJobData,
} from "./template-connector-jobs.js";

/**
 * The consumer of {@link TEMPLATE_CONNECTORS_QUEUE} (`cap-template-connectors`): each
 * `template-connectors-ensure` job creates the org's template connectors it never had
 * (`TemplateConnectorEnsurer`), inside `runJob`. While a template's connector extension is not
 * loaded on this replica yet (an extension the owing transaction enabled loads after its commit),
 * the job creates the others and then throws, so the queue retries it (registry `opts`); the last
 * attempt logs an error with ids only. Worker role only (`TemplateConnectorsWorkersModule`); built
 * with `autorun: false` and started by the worker role after the extensions loaded.
 */
@Injectable()
@Processor(TEMPLATE_CONNECTORS_QUEUE, { autorun: false })
export class TemplateConnectorsProcessor extends WorkerHost<Worker<TemplateConnectorsJobData>> {
  constructor(
    @Inject(TemplateConnectorEnsurer)
    private readonly ensurer: Pick<TemplateConnectorEnsurer, "ensureTemplateConnectorsIn">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {
    super();
  }

  process(job: Job<TemplateConnectorsJobData>): Promise<unknown> {
    return runJob(TEMPLATE_CONNECTORS_QUEUE, job, async () => {
      if (job.name !== TEMPLATE_CONNECTORS_JOB) {
        throw new UnrecoverableError(`unknown template connectors job ${job.name}`);
      }
      // the org scope: runJob enters it from the data's orgId
      const r = await this.ensurer.ensureTemplateConnectorsIn(job.data.orgId);
      if (r.notLoaded > 0) {
        throw new Error(
          `${r.notLoaded} connector template(s) name a connector extension not loaded on this replica yet; retried`,
        );
      }
      return r;
    });
  }

  /** Starts consuming (worker role, after the extensions loaded). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  /** Closes the worker, waiting for the ensure in flight. */
  async close(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent("failed")
  failed(job: Job<TemplateConnectorsJobData> | undefined, err: Error): void {
    if (!job) return;
    const fields = {
      jobId: job.id,
      orgId: job.data.orgId,
      attempt: job.attemptsMade,
      error: err.message,
    };
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      this.log.error("template connector ensure failed on its last attempt; given up", fields);
    } else this.log.warn("template connector ensure failed; retrying", fields);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("template connectors worker error", { err });
  }
}

/**
 * The template connectors queue's consumer; imported only by the worker role (`WorkerModule`).
 * The queue itself is registered by the catalog module (every role owes the jobs).
 */
@Module({
  imports: [CatalogModule],
  providers: [TemplateConnectorsProcessor],
  exports: [TemplateConnectorsProcessor],
})
export class TemplateConnectorsWorkersModule {}
