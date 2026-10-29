// biome-ignore-all lint/suspicious/noExplicitAny: test pools carry no schema types
/**
 * Runtime providers over a test's own pool and Redis, for tests without a running kernel (or that
 * swap a provider's inputs): Task 5.1 moves them to the Nest application.
 */
import type { Logger } from "@capybara-hq/plugin-sdk";
import { type Job, Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import type { KernelConfig } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import { type TitleDeps, TitleGenerator } from "../../src/conversations/titles.js";
import type { HookRegistry } from "../../src/extensions/hooks.js";
import { CacheService } from "../../src/infra/cache/cache.service.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { KyselyCheckpointSaver } from "../../src/runtime/checkpointer.js";
import { type ProviderHost, ProviderRegistry } from "../../src/runtime/providers.js";
import { StepLog } from "../../src/runtime/step-log.js";
import {
  USAGE_REPORT_QUEUE,
  UsageReporter,
  type UsageReportJob,
} from "../../src/runtime/usage-report.js";
import { handlesFor } from "./identity.js";

const quiet = createLogger("error", { write: () => {} });

/** The model provider registry over `host`, caching in `redis` (`@Cacheable`). */
export function providerRegistryFor(
  host: ProviderHost,
  redis: Redis,
  log?: Pick<Logger, "warn">,
  opts: { listTimeoutMs?: number } = {},
): ProviderRegistry {
  return new ProviderRegistry(host, new CacheService(redis, quiet), redis, log, opts.listTimeoutMs);
}

/** The LangGraph checkpoint saver over a test's pool. */
export function checkpointsFor(db: Kysely<any>): KyselyCheckpointSaver {
  const h = handlesFor(db);
  return new KyselyCheckpointSaver(h.db, h.txHost);
}

/** A run step's transactional writes over a test's pool; `eventLog` over the same pool. */
export function stepLogFor(db: Kysely<any>, eventLog: EventLog): StepLog {
  const h = handlesFor(db);
  return new StepLog(h.db, eventLog, h.txHost);
}

/**
 * One conversation title attempt over a test's pool and doubles (`TitleGenerator.run`): `db` and
 * `eventLog` over the same pool.
 */
export function runTitleJob(
  d: Omit<TitleDeps, "writes">,
  conversationId: string,
  attempt: number,
): Promise<void> {
  const h = handlesFor(d.db as Kysely<any>);
  return new TitleGenerator(
    h.db,
    d.eventLog,
    d.purposes,
    d.hooks !== undefined ? { hooks: d.hooks } : undefined,
    d.usageReport,
    d.log,
    h.txHost,
  ).run(conversationId, attempt, d.signal);
}

/** What a hand-built usage reporter runs on (the old `UsageReporterDeps`). */
export interface UsageReporterTestDeps {
  /** The test's pool (not a schema view). */
  pool: Kysely<any>;
  /** The Redis the queue, the worker and the warning markers use. */
  redisUrl: string;
  hooks: Pick<HookRegistry, "handlers" | "has">;
  /** Absent: no plugin is active here. */
  isActive?(plugin: string): boolean;
  /** Absent: none. */
  unservable?(plugins: readonly string[]): Promise<Set<string>>;
  subscribers(orgId?: string): Promise<Set<string>>;
  config: () => KernelConfig;
  log: Logger;
  retry?: { attempts: number; backoffMs: number };
}

/** A usage reporter on its own Redis connections; `startWorker()` consumes like its processor. */
export type TestUsageReporter = Omit<UsageReporter, "startWorker"> & { startWorker(): void };

/**
 * A usage reporter over test doubles: its own queue (and, once started, a worker built like the
 * kernel's `@Processor`: the run queue's job lock and stalled detection). `stop()` closes the
 * worker, the queue and the connections.
 */
export function usageReporterFor(d: UsageReporterTestDeps): TestUsageReporter {
  const h = handlesFor(d.pool);
  const conns: Redis[] = [];
  const conn = () => {
    const c = new Redis(d.redisUrl, { maxRetriesPerRequest: null });
    conns.push(c);
    return c;
  };
  const queue = new Queue<UsageReportJob>(USAGE_REPORT_QUEUE, { connection: conn() });
  const r = new UsageReporter(
    h.db,
    queue,
    {
      hooks: d.hooks as HookRegistry,
      current: (plugin: string) => (d.isActive?.(plugin) ? ({} as never) : undefined),
    },
    { get: d.config },
    new LockService(conn(), quiet),
    d.log,
    d.retry,
  );
  r.subscribers = d.subscribers;
  r.unservable = d.unservable ?? (async () => new Set());
  const start = r.startWorker.bind(r);
  const stop = r.stop.bind(r);
  return Object.assign(r, {
    startWorker() {
      const { jobLockMs, stalledIntervalMs } = d.config().runtime;
      const worker = new Worker<UsageReportJob>(
        USAGE_REPORT_QUEUE,
        (j: Job<UsageReportJob>, t?: string) => r.process(j, t),
        {
          connection: conn(),
          concurrency: d.config().hooks.usageReportConcurrency,
          lockDuration: jobLockMs,
          stalledInterval: stalledIntervalMs,
          maxStalledCount: 3,
          autorun: false,
        },
      );
      worker.on("failed", (j, err) => r.onFailed(j, err));
      worker.on("error", (err) => r.onError(err));
      start(worker);
    },
    async stop() {
      await stop();
      await queue.close().catch(() => {});
      for (const c of conns) await c.quit().catch(() => c.disconnect());
    },
  });
}
