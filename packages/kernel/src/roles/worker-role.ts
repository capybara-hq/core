import { Inject, Injectable } from "@nestjs/common";
import { ChannelsProcessor } from "../channels/channels.module.js";
import { ChannelOutbound } from "../channels/outbound.js";
import type { KernelConfig } from "../config/schema.js";
import { TitleQueue } from "../conversations/titles.js";
import { EvalsProcessor } from "../evals/evals.module.js";
import { EvalWorker } from "../evals/worker.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { LockedIntervalScheduler } from "../infra/schedule/locked-interval.js";
import { ScheduledRuns } from "../infra/schedule/scheduled-runs.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MaintenanceProcessor } from "../runtime/maintenance.js";
import {
  RunsProcessor,
  SubagentRunsProcessor,
  TitleProcessor,
  UsageReportProcessor,
} from "../runtime/run-processors.js";
import { RunWorker } from "../runtime/run-worker.js";
import { UsageReporter } from "../runtime/usage-report.js";

/**
 * The worker role's parts, driven by `KernelLifecycle` at fixed points of its start order and stop
 * phases (so they stay ordered after the extension load and before the extension host closes): the
 * queue consumers (runs, sub-agent runs, evals, maintenance, channel deliveries, `usage.report`,
 * titles) and the schedulers of the `@LockedCron` / `@LockedInterval` jobs. Provided only by
 * `WorkerModule`, so a process without the worker role has none of them.
 */
@Injectable()
export class WorkerRole {
  /** The startup config (the roles). */
  private readonly config: KernelConfig;
  /** The run worker was started: the runs phase drains it. */
  private runsStarted = false;
  /** The eval worker was started: the runs phase drains it. */
  private evalsStarted = false;

  constructor(
    @Inject(KernelConfigService) config: KernelConfigService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(LockedIntervalScheduler) private readonly intervals: LockedIntervalScheduler,
    @Inject(ScheduledRuns) private readonly scheduledRuns: ScheduledRuns,
    @Inject(RunWorker) private readonly runWorker: RunWorker,
    @Inject(EvalWorker) private readonly evalWorker: EvalWorker,
    @Inject(UsageReporter) private readonly usageReport: UsageReporter,
    @Inject(TitleQueue) private readonly titles: TitleQueue,
    @Inject(ChannelOutbound) private readonly channelOutbound: ChannelOutbound,
    @Inject(RunsProcessor) private readonly runsProcessor: RunsProcessor,
    @Inject(SubagentRunsProcessor) private readonly subagentRunsProcessor: SubagentRunsProcessor,
    @Inject(UsageReportProcessor) private readonly usageProcessor: UsageReportProcessor,
    @Inject(TitleProcessor) private readonly titleProcessor: TitleProcessor,
    @Inject(ChannelsProcessor) private readonly channelsProcessor: ChannelsProcessor,
    @Inject(EvalsProcessor) private readonly evalsProcessor: EvalsProcessor,
    @Inject(MaintenanceProcessor) private readonly maintenanceProcessor: MaintenanceProcessor,
  ) {
    this.config = config.get();
  }

  /**
   * Starts the queue consumers (after the extension load). `checkpoint` throws when a stop began
   * meanwhile. The cron and interval timers were armed by the schedulers at application bootstrap;
   * the `runOnStart` runs start at {@link afterStart}.
   */
  async start(checkpoint: () => void): Promise<void> {
    // both run queues' @Processor workers (built with the run config, never autorun)
    this.runWorker.start([this.runsProcessor.worker, this.subagentRunsProcessor.worker]);
    this.runsStarted = true;
    this.evalWorker.start(this.evalsProcessor.worker);
    this.evalsStarted = true;
    // The maintenance queue: remove the retired job schedulers (idempotent, harmless when several
    // replicas do it), then start its one consumer. A failure is only logged and does not stop the
    // start (like the workers' connection errors): any worker replica removes them on its next start.
    try {
      await this.maintenanceProcessor.removeRetiredSchedulers();
    } catch (err) {
      this.log.error("cannot register maintenance job schedulers", { err });
    }
    checkpoint();
    this.maintenanceProcessor.start();
    this.channelOutbound.startWorker(this.channelsProcessor.worker);
    this.usageReport.startWorker(this.usageProcessor.worker);
    this.titles.startWorker(this.titleProcessor.worker);
    if (!this.config.roles.includes("gateway")) {
      this.log.info(
        "this process runs the worker role without gateway; channel long connections are held only by processes with the gateway role",
        { roles: this.config.roles },
      );
    }
  }

  /**
   * The start sequence is done: the `@LockedInterval({ runOnStart })` jobs run once now, in the
   * background (once across replicas starting together).
   */
  afterStart(): void {
    this.intervals.runStartJobs();
  }

  /**
   * Stops the schedulers (no new tick; the runs in progress get the stop signal) and returns the
   * wait for those runs, at most `budgetMs`.
   */
  stopSchedules(budgetMs: number): Promise<void> {
    return this.scheduledRuns.stop(budgetMs);
  }

  /** The runs phase: this process's runs stop at their next step boundary (undefined: never started). */
  drainRuns(budgetMs: number): Promise<void> | undefined {
    return this.runsStarted ? this.runWorker.close(budgetMs) : undefined;
  }

  /** The eval cases in progress stop (undefined: never started). */
  drainEvals(budgetMs: number): Promise<void> | undefined {
    return this.evalsStarted ? this.evalWorker.close(budgetMs) : undefined;
  }

  /** Closes the maintenance queue's worker. */
  closeMaintenance(): Promise<void> {
    return this.maintenanceProcessor.worker.close();
  }
}
