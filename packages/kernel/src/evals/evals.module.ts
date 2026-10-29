import { hostname } from "node:os";
import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { type DynamicModule, Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Worker } from "bullmq";
import type { KernelConfig } from "../config/schema.js";
import { EventLogModule } from "../conversations/event-log.js";
import { IdentityModule } from "../identity/identity.module.js";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { runJob } from "../infra/queue/run-job.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { ProvidersModule } from "../runtime/providers.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { EvalBudgetModule } from "./budget.js";
import { EVAL_QUEUE_NAME, type EvalJobData, EvalJobs } from "./jobs.js";
import { EvalReplaySeeder } from "./run-replay.js";
import { EvalRunsService } from "./runs.service.js";
import { EvalSetsService } from "./sets.service.js";
import { TrajectoryService } from "./trajectory.service.js";
import { EVAL_MAX_STALLED_COUNT, EvalWorker } from "./worker.js";

/**
 * Evals: the trajectory viewer, eval sets and cases, eval runs (the producer of
 * `cap-kernel-evals`) and the run bookkeeping ({@link EvalBudgetModule}, re-exported).
 */
@Module({
  imports: [
    EventLogModule,
    ModelsModule,
    IdentityModule,
    OrgLockModule,
    ProvidersModule,
    EvalBudgetModule,
    QueueModule.registerQueue(EVAL_QUEUE_NAME),
  ],
  providers: [TrajectoryService, EvalSetsService, EvalRunsService, EvalJobs],
  exports: [TrajectoryService, EvalSetsService, EvalRunsService, EvalJobs, EvalBudgetModule],
})
export class EvalsModule {}

/** The consumer of `cap-kernel-evals` (one case per job): {@link EvalWorker}. */
@Injectable()
export class EvalsProcessor extends WorkerHost<Worker<EvalJobData>> {
  constructor(@Inject(EvalWorker) private readonly evals: EvalWorker) {
    super();
  }

  process(job: Job<EvalJobData>, token?: string): Promise<void> {
    return runJob(EVAL_QUEUE_NAME, job, () => this.evals.process(job, token));
  }

  @OnWorkerEvent("failed")
  failed(job: Job<EvalJobData> | undefined, err: Error): void {
    this.evals.onFailed(job, err);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.evals.onError(err);
  }
}

/**
 * The eval worker (step and full-run replays, the judge) over the runtime's loop and model
 * registry, and on the `worker` role the consumer of `cap-kernel-evals`, its options from the
 * startup config (concurrency `evals.workerConcurrency`, the run queues' job lock and stalled
 * detection). The worker never starts by itself: `KernelLifecycle` starts it after the extensions
 * loaded, and drains it on stop.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class EvalWorkersModule {
  static forRoot(config: KernelConfig): DynamicModule {
    const consumes = config.roles.includes("worker");
    const { jobLockMs, stalledIntervalMs } = config.runtime;
    return {
      module: EvalWorkersModule,
      imports: [EvalsModule, RuntimeModule, EventLogModule, ModelsModule],
      providers: [
        EvalReplaySeeder,
        EvalWorker,
        ...(consumes
          ? [
              configuredProcessor(EvalsProcessor, EVAL_QUEUE_NAME, {
                // the worker name is recorded on the job (BullMQ processedBy): which replica ran it
                name: `${hostname()}-${process.pid}`,
                concurrency: config.evals.workerConcurrency,
                lockDuration: jobLockMs,
                stalledInterval: stalledIntervalMs,
                maxStalledCount: EVAL_MAX_STALLED_COUNT,
              }),
            ]
          : []),
      ],
      exports: [EvalWorker, ...(consumes ? [EvalsProcessor] : [])],
    };
  }
}
