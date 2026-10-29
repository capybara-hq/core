import type { Logger } from "@capybara-hq/plugin-sdk";
import { type Job, type JobsOptions, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  MARKETPLACES_REFRESH_SCHEDULER_ID,
  PLUGIN_STAGING_CLEANUP_SCHEDULER_ID,
} from "../catalog/job-ids.js";
import { GATEWAY_CHECK_SCHEDULER_ID } from "../channels/job-ids.js";
import { ATTACHMENT_CLEANUP_SCHEDULER_ID } from "../conversations/attachments.service.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { PLUGINS_RECONCILE_SCHEDULER_ID } from "../extensions/lifecycle-topics.js";
import { withJobContext } from "../log-context.js";
import { DIRECTORY_SCAN_SCHEDULER_ID } from "../orgs/directory-sync.js";
import { OFFBOARD_SWEEP_SCHEDULER_ID } from "../orgs/offboarding.js";
import { STORAGE_PURGE_SCHEDULER_ID } from "../storage/purge.js";
import { DRIFT_SCHEDULER_ID, OUTPUT_CLEANUP_SCHEDULER_ID } from "../tools/job-ids.js";
import { bullConnection } from "./bull-connection.js";
import { USAGE_SWEEP_SCHEDULER_ID, WAIT_SWEEP_SCHEDULER_ID } from "./job-ids.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";

export { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";

/** 维护任务的处理函数（`token` 供 `moveToDelayed` 等使用）。 */
export type MaintenanceHandler = (job: Job, token: string | undefined) => Promise<void>;

/** 由其他模块登记的周期任务（如漂移检测）：scheduler id 与任务名不含 `:`，周期在登记时读取。 */
export interface MaintenanceSchedule {
  id: string;
  name: string;
  everyMs: () => number;
}

export interface MaintenanceDeps {
  db: KernelSchemaDb;
  redisUrl: string;
  log: Pick<Logger, "error" | "warn" | "info">;
}

/**
 * Job scheduler ids of maintenance jobs that became `@LockedCron` jobs (nest kernel Phase 3): an
 * upgraded deployment still has them in Redis, so the worker removes them at start (else BullMQ
 * keeps firing a job no handler knows). Each converting task appends its ids.
 */
export const RETIRED_SCHEDULER_IDS: readonly string[] = [
  // Task 3.1
  STORAGE_PURGE_SCHEDULER_ID,
  // Task 3.2
  DIRECTORY_SCAN_SCHEDULER_ID,
  OFFBOARD_SWEEP_SCHEDULER_ID,
  // Task 3.3
  PLUGINS_RECONCILE_SCHEDULER_ID,
  // Task 3.4
  MARKETPLACES_REFRESH_SCHEDULER_ID,
  PLUGIN_STAGING_CLEANUP_SCHEDULER_ID,
  // Task 3.5
  DRIFT_SCHEDULER_ID,
  OUTPUT_CLEANUP_SCHEDULER_ID,
  // Task 3.6a
  ATTACHMENT_CLEANUP_SCHEDULER_ID,
  // Task 3.6b
  WAIT_SWEEP_SCHEDULER_ID,
  USAGE_SWEEP_SCHEDULER_ID,
  // Task 3.7
  GATEWAY_CHECK_SCHEDULER_ID,
];

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

  constructor(private readonly d: MaintenanceDeps) {}

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
    for (const id of RETIRED_SCHEDULER_IDS) await this.getQueue().removeJobScheduler(id);
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
