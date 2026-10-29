import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import type { KernelConfig } from "../../config/schema.js";
import type { KernelLogger } from "../../log.js";
import { KernelConfigService } from "../config/kernel-config.service.js";
import { KERNEL_LOGGER } from "../tokens.js";
import {
  assertLockedJobHost,
  LOCKED_JOB,
  type LockedJobHost,
  runLockedTick,
  startMarkerTtl,
} from "./locked-tick.js";

/** The period of a `@LockedInterval` job, read from the config (once, when it is scheduled). */
export type IntervalPeriod = (config: KernelConfig) => number;

export interface LockedIntervalOptions {
  /** Redis lock key (default `cron:<name>`); `lock:` is prepended unless present. */
  lockKey?: string;
  /** Lock lifetime without renewal, ms (default 30000); a longer run keeps it by renewal. */
  ttl?: number;
  /**
   * Also run once when the application has started (after the start sequence, without blocking
   * it), once across replicas starting together (see `startMarkerTtl`), as a new repeatable
   * scheduler's first run did.
   */
  runOnStart?: boolean;
}

interface IntervalMeta {
  name: string;
  period: IntervalPeriod;
  /** The start run of `runOnStart` jobs (called with the instance as `this`). */
  start?: (this: IntervalHost) => Promise<void>;
}

const LOCKED_INTERVAL = Symbol("LOCKED_INTERVAL");

/** Timers may fire a little early; a call this close before a tick still belongs to it. */
const EARLY_TOLERANCE_MS = 50;

/** The tick a call at `now` belongs to: the latest multiple of the period at or before it. */
export function intervalTick(periodMs: number, now: number): { tick: number; periodMs: number } {
  const tolerance = Math.min(EARLY_TOLERANCE_MS, Math.floor(periodMs / 2));
  return { tick: Math.floor((now + tolerance) / periodMs) * periodMs, periodMs };
}

/** The class property `@LockedInterval` reads the period from (besides `lockService` and `log`). */
interface IntervalHost extends LockedJobHost {
  config?: KernelConfigService;
}

/**
 * Like `@LockedCron`, for a job whose period comes from the config (a number of milliseconds that
 * a cron expression cannot express, such as `extensionHost.reconcileIntervalSeconds`): every
 * replica fires at the multiples of the period (epoch-aligned, so replicas agree on the tick), and
 * the same two layers run the job exactly once per tick across replicas. The period is read when
 * the application starts (like the old repeatable schedulers, not hot). The method gets the
 * scheduler's stop signal as its only argument (see `ScheduledRuns`). The class must inject
 * `lockService`, `log` and `config` (`KernelConfigService`); {@link LockedIntervalScheduler}
 * schedules every decorated method of the application's providers.
 */
export function LockedInterval(
  name: string,
  period: IntervalPeriod,
  options: LockedIntervalOptions = {},
) {
  return (_target: object, _key: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const lockKey = options.lockKey ?? `cron:${name}`;
    const wrapped = async function (this: IntervalHost) {
      assertLockedJobHost(this, "interval");
      const config = this.config;
      await runLockedTick(this, {
        kind: "interval",
        name,
        lockKey,
        ttl: options.ttl ?? 30_000,
        tick: () => {
          if (!config) {
            throw new Error(
              "@LockedInterval() needs the class to inject `KernelConfigService` as `config`.",
            );
          }
          return intervalTick(period(config.get()), Date.now());
        },
        run: (signal) => Promise.resolve(original.call(this, signal)),
      });
    };
    const start = async function (this: IntervalHost) {
      assertLockedJobHost(this, "interval");
      const config = this.config;
      await runLockedTick(this, {
        kind: "interval",
        name,
        lockKey,
        ttl: options.ttl ?? 30_000,
        tick: () => {
          throw new Error("a start run has no tick");
        },
        start: { ttlMs: startMarkerTtl(config ? period(config.get()) : 60_000) },
        run: (signal) => Promise.resolve(original.call(this, signal)),
      });
    };
    Reflect.defineMetadata(LOCKED_JOB, true, wrapped);
    Reflect.defineMetadata(
      LOCKED_INTERVAL,
      { name, period, ...(options.runOnStart === true && { start }) } satisfies IntervalMeta,
      wrapped,
    );
    descriptor.value = wrapped;
    return descriptor;
  };
}

/**
 * Schedules the `@LockedInterval` jobs of every provider at `onApplicationBootstrap` (each timer
 * fires at the next multiple of the job's period, then re-arms) and stops them when the
 * application stops (`ScheduledRuns` calls {@link stopAll} and waits for the runs in progress).
 * One instance, in `KernelScheduleModule`.
 */
@Injectable()
export class LockedIntervalScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly timers = new Map<string, { timer: NodeJS.Timeout | undefined }>();
  private readonly periods = new Map<string, number>();
  private readonly startRuns: { name: string; run: () => Promise<void> }[] = [];
  private stopped = false;

  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== "object" || !wrapper.isDependencyTreeStatic()) continue;
      const proto = Object.getPrototypeOf(instance) as object | null;
      if (!proto) continue;
      for (const method of this.scanner.getAllMethodNames(proto)) {
        const fn = instance[method];
        if (typeof fn !== "function") continue;
        const meta = Reflect.getMetadata(LOCKED_INTERVAL, fn) as IntervalMeta | undefined;
        if (!meta) continue;
        if (this.timers.has(meta.name)) {
          throw new Error(`@LockedInterval job name ${meta.name} is used twice`);
        }
        const periodMs = meta.period(this.config.get());
        if (!Number.isFinite(periodMs) || periodMs < 100) {
          throw new Error(`@LockedInterval job ${meta.name}: period ${periodMs} ms is too short`);
        }
        this.periods.set(meta.name, periodMs);
        this.arm(meta.name, periodMs, () => (fn as () => Promise<void>).call(instance));
        const start = meta.start;
        if (start) {
          this.startRuns.push({
            name: meta.name,
            run: () => start.call(instance as IntervalHost),
          });
        }
      }
    }
  }

  /** The scheduled job names. */
  names(): string[] {
    return [...this.timers.keys()];
  }

  /** A scheduled job's period in ms (read from the config at bootstrap), undefined when unknown. */
  periodOf(name: string): number | undefined {
    return this.periods.get(name);
  }

  /**
   * Starts the start runs of the `runOnStart` jobs in the background (each once across replicas
   * starting together) and returns their promises. The kernel lifecycle calls it once its start
   * sequence is done; later calls start nothing.
   */
  runStartJobs(): Promise<void>[] {
    const runs = this.stopped ? [] : this.startRuns.splice(0);
    return runs.map(({ name, run }) =>
      run().catch((err: unknown) =>
        this.log.error("interval start run failed", { job: name, err }),
      ),
    );
  }

  /** Stops one job's timer (a run in progress finishes). */
  stop(name: string): void {
    const t = this.timers.get(name);
    if (t?.timer) clearTimeout(t.timer);
    this.timers.delete(name);
  }

  /** Stops every timer and drops the start runs not started yet (idempotent). */
  stopAll(): void {
    this.stopped = true;
    this.startRuns.splice(0);
    for (const name of [...this.timers.keys()]) this.stop(name);
  }

  onModuleDestroy(): void {
    this.stopAll();
  }

  private arm(name: string, periodMs: number, run: () => Promise<void>): void {
    const slot: { timer: NodeJS.Timeout | undefined } = { timer: undefined };
    this.timers.set(name, slot);
    const next = () => {
      const now = Date.now();
      const at = (Math.floor(now / periodMs) + 1) * periodMs;
      slot.timer = setTimeout(() => {
        if (this.stopped || this.timers.get(name) !== slot) return;
        next();
        // runLockedTick never throws for a job error; this catches only a missing host property
        run().catch((err: unknown) => this.log.error("interval job failed", { job: name, err }));
      }, at - now);
      slot.timer.unref();
    };
    next();
  }
}
