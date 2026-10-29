import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import { SchedulerRegistry } from "@nestjs/schedule";
import type { KernelLogger } from "../../log.js";
import { GracefulShutdown } from "../lifecycle/graceful-shutdown.service.js";
import { KERNEL_LOGGER } from "../tokens.js";
import { LockedIntervalScheduler } from "./locked-interval.js";
import { LOCKED_JOB, SCHEDULED_RUNS, type ScheduledRunScope } from "./locked-tick.js";

/**
 * The runs of the `@LockedCron` / `@LockedInterval` jobs (ticks and `runOnStart` runs), their
 * start gate ({@link open}, R21) and their stop. At application bootstrap it attaches itself to every provider instance with a locked job
 * (`SCHEDULED_RUNS`), so each run is tracked and gets {@link signal}. {@link stop} (idempotent)
 * stops the cron and interval timers, aborts the signal, refuses new runs and waits for the runs in
 * progress within its budget, capped by what is left of the shared stop deadline
 * (`GracefulShutdown`): the runs end (and release their locks) before Redis and the pool close.
 * Runs over the budget are abandoned with a WARN; the job's own failures after the stop began are
 * logged at WARN / INFO, never ERROR. The kernel's stop phases call it through the worker role
 * (`WorkerRole.stopSchedules`, awaited in the runs phase, before the extension host closes: jobs may
 * call extensions); `beforeApplicationShutdown` covers an application without them.
 */
@Injectable()
export class ScheduledRuns
  implements ScheduledRunScope, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly abort = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopping: Promise<void> | undefined;
  private gateOpen = false;

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(SchedulerRegistry) private readonly crons: SchedulerRegistry,
    @Inject(LockedIntervalScheduler) private readonly intervals: LockedIntervalScheduler,
    @Inject(GracefulShutdown) private readonly shutdown: GracefulShutdown,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== "object" || !wrapper.isDependencyTreeStatic()) continue;
      const proto = Object.getPrototypeOf(instance) as object | null;
      if (!proto) continue;
      const hasJob = this.scanner.getAllMethodNames(proto).some((m) => {
        const fn = instance[m];
        return typeof fn === "function" && Reflect.getMetadata(LOCKED_JOB, fn) === true;
      });
      if (hasJob) {
        Object.defineProperty(instance, SCHEDULED_RUNS, { value: this, configurable: true });
      }
    }
  }

  /** The start gate is open: ticks and start runs may run (R21). */
  get opened(): boolean {
    return this.gateOpen && this.stopping === undefined;
  }

  /**
   * Opens the start gate (R21). Until this is called every tick and start run skips at INFO: the
   * cron and interval timers are armed at application bootstrap, which runs before the kernel's
   * start sequence (migrations, bootstrap, extension load). The kernel's worker role opens it once
   * its queue consumers started (then starts the `runOnStart` runs); a stop closes it again.
   */
  open(): void {
    if (this.stopping === undefined) this.gateOpen = true;
  }

  get stopped(): boolean {
    return this.stopping !== undefined;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** The number of runs in progress. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const forget = () => {
      this.inFlight.delete(p);
    };
    p.then(forget, forget);
    return p;
  }

  /**
   * Stops the schedulers and waits for the runs in progress, at most `budgetMs` (capped by the
   * shared stop deadline). Idempotent: later calls return the first call's promise.
   */
  stop(budgetMs: number): Promise<void> {
    this.stopping ??= this.runStop(budgetMs);
    return this.stopping;
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop(this.shutdown.remainingMs());
  }

  private async runStop(budgetMs: number): Promise<void> {
    this.gateOpen = false;
    for (const job of this.crons.getCronJobs().values()) void job.stop();
    this.intervals.stopAll();
    this.abort.abort(new Error("the scheduler is stopping"));
    if (this.inFlight.size === 0) return;
    const waitMs = Math.max(0, Math.min(budgetMs, this.shutdown.remainingMs()));
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
      timer.unref();
    });
    try {
      const r = await Promise.race([
        Promise.allSettled([...this.inFlight]).then(() => "done" as const),
        deadline,
      ]);
      if (r === "timeout") {
        this.log.warn("shutdown: scheduled jobs did not stop in time; abandoned", {
          inFlight: this.inFlight.size,
          budgetMs: waitMs,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
