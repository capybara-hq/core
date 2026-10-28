import type { Logger } from "@capybara-hq/plugin-sdk";
import { type Job, type JobsOptions, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";
import { withJobContext } from "../log-context.js";
import { bullConnection } from "./run-queue.js";

/**
 * 内核维护队列（不含 `:`）：等待超时任务（`wait-timeout`，见 waits.ts）与周期性维护（输出存档清理、
 * 工具漂移检测（见 tools/drift.ts）、等待兜底扫描（`wait-sweep`，见 waits.ts）、沙箱的空闲休眠与不活跃销毁
 * （见 sandbox/lifecycle.ts）等）。整个队列只有一个 Worker（只在 `worker` 角色上启动），
 * 按任务名分派给登记的处理函数。
 * 与运行队列分开：运行 worker 的处理函数、stalled / 失败处理都按「一个任务 = 一次运行」设计；
 * 维护任务短、无会话锁与配额。
 */
export const MAINTENANCE_QUEUE_NAME = "cap-kernel-maintenance";

/** 输出存档清理：任务名、job scheduler id（不含 `:`）、周期与每批删除行数。 */
export const OUTPUT_CLEANUP_JOB = "output-cleanup";
export const OUTPUT_CLEANUP_SCHEDULER_ID = "output-cleanup-hourly";
export const OUTPUT_CLEANUP_EVERY_MS = 3_600_000;
export const OUTPUT_CLEANUP_BATCH = 1000;

/**
 * Periodic marketplace refresh (C26): job name and job scheduler id (no `:`), every
 * `marketplaces.refreshIntervalMinutes`. One scheduler for all replicas; the handler refreshes each
 * enabled marketplace in turn (see catalog/marketplaces.service.ts). The values keep their old
 * names: the scheduler id is stored in Redis, and renaming it would leave the old scheduler behind.
 */
export const MARKETPLACES_REFRESH_JOB = "catalogs-refresh";
export const MARKETPLACES_REFRESH_SCHEDULER_ID = "catalogs-refresh-every";

/**
 * Cleanup of plugin (app bundle) import staging (T25, F-AE): job name and job scheduler id (no
 * `:`), hourly; deletes expired (24-hour) staging rows and their object storage prefixes (see
 * catalog/plugin-import.ts `PluginImport.cleanupExpired`). The values keep their old names: the
 * scheduler id is stored in Redis, so renaming it would leave the old scheduler behind.
 */
export const PLUGIN_STAGING_CLEANUP_JOB = "app-staging-cleanup";
export const PLUGIN_STAGING_CLEANUP_SCHEDULER_ID = "app-staging-cleanup-hourly";
export const PLUGIN_STAGING_CLEANUP_EVERY_MS = 3_600_000;

/** 维护任务的处理函数（`token` 供 `moveToDelayed` 等使用）。 */
export type MaintenanceHandler = (job: Job, token: string | undefined) => Promise<void>;

/** 由其他模块登记的周期任务（如漂移检测）：scheduler id 与任务名不含 `:`，周期在登记时读取。 */
export interface MaintenanceSchedule {
  id: string;
  name: string;
  everyMs: () => number;
}

/**
 * 删除已过期（`expires_at < now()`）的输出存档，每批 `batch` 行，直到删完；返回删除的总行数。
 * 每批一条独立语句（不开长事务）；多个 worker 同时清理时 `SKIP LOCKED` 互不等待。
 */
export async function deleteExpiredOutputs(
  db: KernelDb,
  batch = OUTPUT_CLEANUP_BATCH,
): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await db
      .deleteFrom("tool_outputs")
      .where(
        "id",
        "in",
        db
          .selectFrom("tool_outputs")
          .select("id")
          .where("expires_at", "<", sql<Date>`now()`)
          .limit(batch)
          .forUpdate()
          .skipLocked(),
      )
      .executeTakeFirst();
    const n = Number(r.numDeletedRows);
    total += n;
    if (n < batch) return total;
  }
}

export interface MaintenanceDeps {
  db: KernelDb;
  redisUrl: string;
  log: Pick<Logger, "error" | "warn" | "info">;
}

/**
 * 维护队列的生产方与（worker 角色上的）唯一 Worker。状态都在 Redis / PG，没有进程内定时器：
 * 周期任务用 BullMQ job scheduler（`upsertJobScheduler` 幂等，多副本重复调用只有一个 scheduler）。
 */
export class Maintenance {
  private queue: Queue | undefined;
  private queueConn: Redis | undefined;
  private worker: Worker | undefined;
  private workerConn: Redis | undefined;
  private closed = false;
  private readonly handlers = new Map<string, MaintenanceHandler>();
  private readonly schedules: MaintenanceSchedule[] = [];

  constructor(private readonly d: MaintenanceDeps) {
    this.handle(OUTPUT_CLEANUP_JOB, async () => {
      const n = await deleteExpiredOutputs(d.db);
      if (n > 0) d.log.info("expired tool outputs deleted", { count: n });
    });
  }

  /** 登记某个任务名的处理函数（构造期调用；Worker 启动前后都可）。 */
  handle(name: string, fn: MaintenanceHandler): void {
    this.handlers.set(name, fn);
  }

  /** 登记一个周期任务（构造期调用；`ensureSchedules` 时一并 upsert）。 */
  schedule(s: MaintenanceSchedule): void {
    this.schedules.push(s);
  }

  /** 投递一个维护任务。 */
  async add(name: string, data: unknown, opts: JobsOptions): Promise<void> {
    await this.getQueue().add(name, data, opts);
  }

  /** 登记周期任务的 job scheduler（幂等；worker 角色启动时调用）。 */
  async ensureSchedules(): Promise<void> {
    await this.getQueue().upsertJobScheduler(
      OUTPUT_CLEANUP_SCHEDULER_ID,
      { every: OUTPUT_CLEANUP_EVERY_MS },
      {
        name: OUTPUT_CLEANUP_JOB,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 100 },
      },
    );
    for (const s of this.schedules) {
      await this.getQueue().upsertJobScheduler(
        s.id,
        { every: s.everyMs() },
        { name: s.name, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    }
  }

  /** 启动维护队列的 Worker（只在含 `worker` 角色的进程）。 */
  startWorker(): void {
    if (this.worker || this.closed) return;
    this.workerConn = bullConnection(this.d.redisUrl, this.d.log);
    this.worker = new Worker(
      MAINTENANCE_QUEUE_NAME,
      (job, token) => withJobContext(MAINTENANCE_QUEUE_NAME, job, () => this.process(job, token)),
      {
        connection: this.workerConn,
        concurrency: 5,
      },
    );
    this.worker.on("error", (err) => this.d.log.error("maintenance worker error", { err }));
    this.worker.on("failed", (job, err) =>
      this.d.log.error("maintenance job failed", { name: job?.name, jobId: job?.id, err }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    const q = this.queue;
    this.worker = undefined;
    this.queue = undefined;
    await w?.close().catch(() => {});
    await q?.close().catch(() => {});
    for (const c of [this.workerConn, this.queueConn]) {
      if (c) await c.quit().catch(() => c.disconnect());
    }
    this.workerConn = undefined;
    this.queueConn = undefined;
  }

  private getQueue(): Queue {
    if (this.closed) throw new Error("maintenance queue is closed");
    if (!this.queue) {
      this.queueConn = bullConnection(this.d.redisUrl, this.d.log);
      this.queue = new Queue(MAINTENANCE_QUEUE_NAME, { connection: this.queueConn });
      this.queue.on("error", (err) => this.d.log.error("maintenance queue error", { err }));
    }
    return this.queue;
  }

  private async process(job: Job, token: string | undefined): Promise<void> {
    const fn = this.handlers.get(job.name);
    if (!fn) {
      this.d.log.warn("unknown maintenance job", { name: job.name, jobId: job.id });
      return;
    }
    await fn(job, token);
  }
}
