import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import { type Job, UnrecoverableError, type Worker } from "bullmq";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { runJob } from "../infra/queue/run-job.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { PushDelivery } from "./delivery.js";
import { PushFanout } from "./fanout.js";
import {
  PUSH_DELIVER_JOB,
  PUSH_FANOUT_JOB,
  PUSH_QUEUE,
  type PushDeliverData,
  type PushFanoutData,
} from "./jobs.js";
import { PushHostModule } from "./provider-host.js";
import { PushModule } from "./push.module.js";
import { PushStaleJob } from "./stale.job.js";

/** Concurrent push jobs per worker replica (each is one provider call, mostly network wait). */
const PUSH_CONCURRENCY = 8;

/** Data of any job on {@link PUSH_QUEUE}. */
type PushJobData = PushDeliverData | PushFanoutData;

/**
 * The consumer of {@link PUSH_QUEUE} (`cap-push-deliver`): `push-fanout` jobs go to
 * {@link PushFanout}, `push-deliver` jobs to {@link PushDelivery}, each inside `runJob`. Worker
 * role only (`PushWorkersModule`); built with `autorun: false` and started by the worker role
 * after the extensions loaded, so no job runs
 * before its provider could be loaded. A retry logs a warning and the last failed attempt an
 * error, with ids and the failure only (never the token).
 */
@Injectable()
@Processor(PUSH_QUEUE, { autorun: false, concurrency: PUSH_CONCURRENCY })
export class PushProcessor extends WorkerHost<Worker<PushJobData>> {
  constructor(
    @Inject(PushDelivery) private readonly delivery: PushDelivery,
    @Inject(PushFanout) private readonly fanout: PushFanout,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {
    super();
  }

  process(job: Job<PushJobData>): Promise<unknown> {
    return runJob(PUSH_QUEUE, job, async () => {
      switch (job.name) {
        case PUSH_FANOUT_JOB:
          return this.fanout.run(job.data as PushFanoutData);
        case PUSH_DELIVER_JOB:
          return this.delivery.deliver(job.data as PushDeliverData);
        default:
          throw new UnrecoverableError(`unknown push job ${job.name}`);
      }
    });
  }

  /** Starts consuming (worker role, after the extensions loaded). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  /**
   * Closes the worker, waiting for the jobs in flight: each send is bounded by the send time
   * limit, and aborting one the provider may already have accepted would only resend it.
   */
  async close(): Promise<void> {
    await this.worker.close();
  }

  @OnWorkerEvent("failed")
  failed(job: Job<PushJobData> | undefined, err: Error): void {
    if (!job) return;
    const fields = {
      jobId: job.id,
      job: job.name,
      eventId: job.data.eventId,
      ...("registrationId" in job.data && { registrationId: job.data.registrationId }),
      attempt: job.attemptsMade,
      error: err.message,
    };
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      this.log.error("push job failed on its last attempt; given up", fields);
    } else this.log.warn("push job failed; retrying", fields);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("push worker error", { err });
  }
}

/**
 * The push queue's consumer (fanout and delivery) and the stale registration prune; imported only
 * by the worker role (`WorkerModule`). The queue itself is registered by {@link PushModule} (every
 * role owes jobs).
 */
@Module({
  imports: [PushModule, PushHostModule, ExtensionsModule],
  providers: [PushDelivery, PushFanout, PushProcessor, PushStaleJob],
  exports: [PushProcessor],
})
export class PushWorkersModule {}
