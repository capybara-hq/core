import { hostname } from "node:os";
import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { type DynamicModule, Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Worker } from "bullmq";
import type { KernelConfig } from "../config/schema.js";
import { TITLE_QUEUE, TitleQueue, TitlesModule } from "../conversations/titles.js";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { runJob } from "../infra/queue/run-job.js";
import { RUN_QUEUE_NAME, type RunJobData, SUBAGENT_RUN_QUEUE_NAME } from "./run-jobs.js";
import { MAX_STALLED_COUNT, RunWorker } from "./run-worker.js";
import { RuntimeModule } from "./runtime.module.js";
import {
  USAGE_REPORT_QUEUE,
  UsageReporter,
  type UsageReportJob,
  UsageReportModule,
} from "./usage-report.js";

type RunResult = Awaited<ReturnType<RunWorker["process"]>>;

/** The consumer of `cap-kernel-runs` (conversation runs): {@link RunWorker}. */
@Injectable()
export class RunsProcessor extends WorkerHost<Worker<RunJobData, RunResult>> {
  constructor(@Inject(RunWorker) private readonly runs: RunWorker) {
    super();
  }

  process(job: Job<RunJobData>, token?: string): Promise<RunResult> {
    return runJob(RUN_QUEUE_NAME, job, () => this.runs.process(job, token));
  }

  @OnWorkerEvent("completed")
  completed(job: Job<RunJobData>, result: RunResult): void {
    this.runs.onCompleted(job, result);
  }

  @OnWorkerEvent("failed")
  failed(job: Job<RunJobData> | undefined, err: Error): void {
    this.runs.onFailed(job, err);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.runs.onError(err, RUN_QUEUE_NAME);
  }
}

/** The consumer of `cap-kernel-subagent-runs` (sub-agent runs, spec §7.4): {@link RunWorker}. */
@Injectable()
export class SubagentRunsProcessor extends WorkerHost<Worker<RunJobData, RunResult>> {
  constructor(@Inject(RunWorker) private readonly runs: RunWorker) {
    super();
  }

  process(job: Job<RunJobData>, token?: string): Promise<RunResult> {
    return runJob(SUBAGENT_RUN_QUEUE_NAME, job, () => this.runs.process(job, token));
  }

  @OnWorkerEvent("completed")
  completed(job: Job<RunJobData>, result: RunResult): void {
    this.runs.onCompleted(job, result);
  }

  @OnWorkerEvent("failed")
  failed(job: Job<RunJobData> | undefined, err: Error): void {
    this.runs.onFailed(job, err);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.runs.onError(err, SUBAGENT_RUN_QUEUE_NAME);
  }
}

/** The consumer of `cap-kernel-usage-report`: {@link UsageReporter}. */
@Injectable()
export class UsageReportProcessor extends WorkerHost<Worker<UsageReportJob>> {
  constructor(@Inject(UsageReporter) private readonly reporter: UsageReporter) {
    super();
  }

  process(job: Job<UsageReportJob>, token?: string): Promise<void> {
    return runJob(USAGE_REPORT_QUEUE, job, () => this.reporter.process(job, token));
  }

  @OnWorkerEvent("failed")
  failed(job: Job<UsageReportJob> | undefined, err: Error): void {
    this.reporter.onFailed(job, err);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.reporter.onError(err);
  }
}

/** The consumer of `cap-kernel-titles`: {@link TitleQueue}. */
@Injectable()
export class TitleProcessor extends WorkerHost<
  Worker<{ conversationId: string; attempt: number }>
> {
  constructor(@Inject(TitleQueue) private readonly titles: TitleQueue) {
    super();
  }

  process(job: Job<{ conversationId: string; attempt: number }>): Promise<void> {
    return runJob(TITLE_QUEUE, job, () => this.titles.process(job));
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.titles.onError(err);
  }
}

/**
 * The runtime's queue consumers: the run worker on both run queues, `usage.report` deliveries and
 * conversation titles, on the `worker` role only (other roles get no processor, so no BullMQ
 * worker). Their worker options come from the startup config (concurrency per queue, the run
 * queues' job lock and stalled detection, which the usage and title workers follow). The workers
 * never start by themselves: `KernelLifecycle` starts them after the extensions loaded, and pauses
 * them on stop.
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class RuntimeWorkersModule {
  static forRoot(config: KernelConfig): DynamicModule {
    const { workerConcurrency, jobLockMs, stalledIntervalMs } = config.runtime;
    const runs = {
      // the worker name is recorded on the job (BullMQ processedBy): which replica ran it
      name: `${hostname()}-${process.pid}`,
      concurrency: workerConcurrency,
      lockDuration: jobLockMs,
      stalledInterval: stalledIntervalMs,
      maxStalledCount: MAX_STALLED_COUNT,
    };
    const processors = [RunsProcessor, SubagentRunsProcessor, UsageReportProcessor, TitleProcessor];
    const consumes = config.roles.includes("worker");
    return {
      module: RuntimeWorkersModule,
      imports: [RuntimeModule, TitlesModule, UsageReportModule],
      providers: consumes
        ? [
            configuredProcessor(RunsProcessor, RUN_QUEUE_NAME, runs),
            configuredProcessor(SubagentRunsProcessor, SUBAGENT_RUN_QUEUE_NAME, runs),
            configuredProcessor(UsageReportProcessor, USAGE_REPORT_QUEUE, {
              concurrency: config.hooks.usageReportConcurrency,
              lockDuration: jobLockMs,
              stalledInterval: stalledIntervalMs,
              maxStalledCount: 3,
            }),
            configuredProcessor(TitleProcessor, TITLE_QUEUE, {
              concurrency: 4,
              lockDuration: jobLockMs,
              stalledInterval: stalledIntervalMs,
              maxStalledCount: 1,
            }),
          ]
        : [],
      exports: [RuntimeModule, TitlesModule, UsageReportModule, ...(consumes ? processors : [])],
    };
  }
}
