import type { HookHandler, HookPayloads } from "@capybara-hq/plugin-sdk";
import { getQueueToken, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import type { Job, JobsOptions, Queue, Worker } from "bullmq";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { runJob } from "../infra/queue/run-job.js";
import { LockedInterval } from "../infra/schedule/locked-interval.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ExtensionsModule } from "./extensions.module.js";
import { deepFreeze, errMsg, HookNeedsConfigError, type LifecycleHook } from "./hooks.js";
import { ExtensionHost } from "./host.js";

/** Queue of lifecycle hook deliveries (no `:` in the name). */
export const LIFECYCLE_QUEUE = "cap-kernel-lifecycle";
/** The job name of every delivery. */
export const LIFECYCLE_JOB = "lifecycle";
/** One job per delivery row (row ids are UUIDs: no `:`). */
export const lifecycleJobId = (deliveryId: string) => `lifecycle-${deliveryId}`;
/** First attempt plus 9 retries per job (the sweeper offers a row again once its job is gone). */
export const LIFECYCLE_ATTEMPTS = 10;
/** Retry backoff: 5 s, doubling. */
export const LIFECYCLE_BACKOFF_MS = 5000;
/** One handler call's time limit. */
export const LIFECYCLE_HOOK_TIMEOUT_MS = 5000;
/** The sweeper's period. */
export const LIFECYCLE_SWEEP_PERIOD_MS = 60_000;
/** The sweeper offers undelivered rows at least this old (the fast path had its chance). */
export const LIFECYCLE_SWEEP_AGE_MS = 30_000;
/**
 * An undelivered row this old is given up (marked delivered with a warning: the plugin is gone);
 * delivered rows are deleted after the same time.
 */
export const LIFECYCLE_KEEP_MS = 7 * 86_400_000;
/** The sweeper's job name (no `:`). */
export const LIFECYCLE_SWEEP_JOB = "lifecycle-sweep";
/** Concurrent deliveries per worker replica. */
const LIFECYCLE_CONCURRENCY = 4;
const SWEEP_PAGE = 500;
/** Upper bound on the pages one sweep offers. */
const SWEEP_MAX_PAGES = 20;

/** Job data: the delivery row's id (the mount, payload and plugin are read when the job runs). */
export interface LifecycleJob {
  deliveryId: string;
}

/** Test seam of the kernel's own tests: a shorter backoff, and enqueues dropped on purpose. */
export interface LifecycleDeliveryHooks {
  backoffMs?: number;
  /** True: {@link LifecycleHooks.enqueue} enqueues nothing (the sweeper must deliver). */
  dropEnqueue?: boolean;
}
/** Optional provider of {@link LifecycleDeliveryHooks} (absent in production). */
export const LIFECYCLE_DELIVERY_HOOKS = Symbol("LIFECYCLE_DELIVERY_HOOKS");

/**
 * Plugins that subscribe to a lifecycle mount according to deployment state: an approved
 * permission snapshot that declares the mount in `permissions.hooks`, for a plugin the deployment
 * still knows (an enabled install, or a config-declared plugin with a replica status row that is
 * not `unloaded`; the same rule as `usage.report` subscribers). Org enablement does not count:
 * cleanup concerns data the plugin already holds (memory plugin spec §6.3). Sorted by name.
 */
export async function queryLifecycleSubscribers(
  db: KernelSchemaDb,
  mount: LifecycleHook,
): Promise<string[]> {
  const rows = await db
    .selectFrom("extension_permission_snapshots as s")
    .select("s.plugin")
    .distinct()
    .where(sql<boolean>`s.permissions -> 'permissions' -> 'hooks' ? ${mount}`)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom("extension_installs as i")
            .select(sql`1`.as("one"))
            .whereRef("i.name", "=", "s.plugin")
            .where("i.desired_state", "=", "enabled"),
        ),
        eb.exists(
          eb
            .selectFrom("extension_replica_status as r")
            .select(sql`1`.as("one"))
            .whereRef("r.plugin", "=", "s.plugin")
            .where("r.source", "=", "config")
            .where("r.state", "<>", "unloaded"),
        ),
      ]),
    )
    .orderBy("s.plugin")
    .execute();
  return rows.map((r) => r.plugin);
}

/**
 * Durable delivery of the lifecycle hooks `org.member_removed`, `agent.deleted` and `org.deleted`
 * (memory plugin spec §6.3), so extensions reliably learn to delete the data they hold:
 * - **Record** ({@link recordIn}): in the transaction that removes the member, the agent or the
 *   org, one `lifecycle_deliveries` row per subscribing plugin ({@link queryLifecycleSubscribers});
 *   a rollback records nothing.
 * - **Enqueue** ({@link enqueue}): after the commit, job `lifecycle-<deliveryId>` on
 *   {@link LIFECYCLE_QUEUE} (10 attempts, backoff from 5 s). Never throws: the sweeper catches up.
 * - **Deliver** ({@link process}, worker role): reads the row; the plugin's handlers loaded on this
 *   replica are called in turn (5 s each, through the instance's in-flight tracker, with its
 *   effective config for the payload's org), then `delivered_at` is set. Not loaded on this replica
 *   -> the job fails and is retried (another replica or a later attempt). Loaded without a handler,
 *   or an effective config not valid in the org (no call is made there, layering spec A §6), or a
 *   row older than 7 days -> marked delivered with a warning. A delivered row is never called again.
 * - **Sweep** ({@link sweep}, {@link LifecycleSweepJob} every minute, once across replicas): offers
 *   undelivered rows older than 30 s again with the same job ids (deduped while a job exists), and
 *   deletes rows delivered more than 7 days ago.
 * Handlers must be idempotent (a delivery may repeat when a replica dies after the call).
 */
@Injectable()
export class LifecycleHooks {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(getQueueToken(LIFECYCLE_QUEUE)) private readonly queue: Queue<LifecycleJob>,
    /** The loaded plugins' handlers (`hooks.handlers`) and whether a plugin is active here. */
    @Inject(ExtensionHost) private readonly host: Pick<ExtensionHost, "hooks" | "current">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Optional()
    @Inject(LIFECYCLE_DELIVERY_HOOKS)
    private readonly seam: LifecycleDeliveryHooks = {},
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * Records one delivery per subscribing plugin in the caller's transaction (`mandatory`) and
   * returns the row ids, which the caller passes to {@link enqueue} after the commit.
   */
  @Transactional({ propagation: "mandatory" })
  async recordIn<K extends LifecycleHook>(mount: K, payload: HookPayloads[K]): Promise<string[]> {
    const plugins = await queryLifecycleSubscribers(this.db, mount);
    if (plugins.length === 0) return [];
    const json = JSON.stringify(payload);
    const rows = await this.db
      .insertInto("lifecycle_deliveries")
      .values(plugins.map((plugin) => ({ mount, payload: json, plugin })))
      .returning("id")
      .execute();
    return rows.map((r) => r.id);
  }

  private jobOpts(deliveryId: string): JobsOptions {
    return {
      jobId: lifecycleJobId(deliveryId),
      attempts: LIFECYCLE_ATTEMPTS,
      backoff: { type: "exponential", delay: this.seam.backoffMs ?? LIFECYCLE_BACKOFF_MS },
      // the row is the durable trace: a finished job goes, so the sweeper can offer the row again
      removeOnComplete: true,
      removeOnFail: true,
    };
  }

  /** Enqueues the deliveries (call it after the commit). Never throws: a failure only logs. */
  async enqueue(ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || this.seam.dropEnqueue === true) return;
    try {
      await this.queue.addBulk(
        ids.map((deliveryId) => ({
          name: LIFECYCLE_JOB,
          data: { deliveryId },
          opts: this.jobOpts(deliveryId),
        })),
      );
    } catch (err) {
      this.log.warn("cannot enqueue lifecycle hook deliveries", { count: ids.length, err });
    }
  }

  /**
   * One sweep: deletes rows delivered more than 7 days ago, then offers the undelivered rows older
   * than 30 s again (oldest first, in pages). Returns the number of rows offered.
   */
  async sweep(): Promise<number> {
    await this.db
      .deleteFrom("lifecycle_deliveries")
      .where(
        sql<boolean>`delivered_at < now() - make_interval(secs => ${LIFECYCLE_KEEP_MS / 1000})`,
      )
      .execute();
    let offered = 0;
    let after: { at: string; id: string } | undefined;
    for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
      let q = this.db
        .selectFrom("lifecycle_deliveries")
        .select(["id", sql<string>`created_at::text`.as("at")])
        .where("delivered_at", "is", null)
        .where(
          sql<boolean>`created_at < now() - make_interval(secs => ${LIFECYCLE_SWEEP_AGE_MS / 1000})`,
        );
      if (after) {
        q = q.where(sql<boolean>`(created_at, id) > (${after.at}::timestamptz, ${after.id}::uuid)`);
      }
      const rows = await q.orderBy("created_at").orderBy("id").limit(SWEEP_PAGE).execute();
      if (rows.length > 0) {
        await this.queue.addBulk(
          rows.map((r) => ({
            name: LIFECYCLE_JOB,
            data: { deliveryId: r.id },
            opts: this.jobOpts(r.id),
          })),
        );
        offered += rows.length;
      }
      const last = rows.at(-1);
      if (!last || rows.length < SWEEP_PAGE) break;
      after = { at: last.at, id: last.id };
    }
    return offered;
  }

  /** One delivery job (the consumer {@link LifecycleHooksProcessor} calls it). */
  async process(data: LifecycleJob, stop: AbortSignal): Promise<void> {
    const row = await this.db
      .selectFrom("lifecycle_deliveries")
      .select([
        "id",
        "mount",
        "payload",
        "plugin",
        "delivered_at",
        sql<boolean>`created_at < now() - make_interval(secs => ${LIFECYCLE_KEEP_MS / 1000})`.as(
          "expired",
        ),
      ])
      .where("id", "=", data.deliveryId)
      .executeTakeFirst();
    if (!row || row.delivered_at !== null) return;
    const fields = { deliveryId: row.id, mount: row.mount, plugin: row.plugin };
    if (row.expired) {
      this.log.warn("lifecycle hook delivery given up after 7 days: the plugin is gone", fields);
      await this.markDelivered(row.id);
      return;
    }
    const handlers = this.host.hooks
      .handlers(row.mount)
      .filter((h) => h.plugin === row.plugin)
      .map((h) => h.handler as HookHandler<LifecycleHook>);
    if (handlers.length === 0) {
      if (this.host.current(row.plugin) === undefined) {
        // another replica or a later attempt may have it loaded
        throw new Error(`plugin ${row.plugin} is not loaded on this replica`);
      }
      this.log.warn("lifecycle hook delivery dropped: the plugin registered no handler", fields);
      await this.markDelivered(row.id);
      return;
    }
    await this.db
      .updateTable("lifecycle_deliveries")
      .set({ attempts: sql<number>`attempts + 1` })
      .where("id", "=", row.id)
      .execute();
    const payload = deepFreeze(
      structuredClone(row.payload),
    ) as unknown as HookPayloads[LifecycleHook];
    try {
      for (const h of handlers) await this.call(h, payload, stop);
    } catch (err) {
      if (!(err instanceof HookNeedsConfigError)) throw err;
      this.log.warn("lifecycle hook delivery dropped: the plugin needs configuration in the org", {
        ...fields,
        orgId: payload.orgId,
      });
    }
    await this.markDelivered(row.id);
  }

  private async markDelivered(id: string): Promise<void> {
    await this.db
      .updateTable("lifecycle_deliveries")
      .set({ delivered_at: sql<Date>`now()` as unknown as Date })
      .where("id", "=", id)
      .where("delivered_at", "is", null)
      .execute();
  }

  /** One handler call, aborted after {@link LIFECYCLE_HOOK_TIMEOUT_MS} or when the replica stops. */
  private async call(
    h: HookHandler<LifecycleHook>,
    payload: HookPayloads[LifecycleHook],
    stop: AbortSignal,
  ): Promise<void> {
    const ac = new AbortController();
    const onStop = () => ac.abort(new Error("replica stopping"));
    if (stop.aborted) onStop();
    else stop.addEventListener("abort", onStop, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => h(payload, ac.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`timed out after ${LIFECYCLE_HOOK_TIMEOUT_MS} ms`);
            ac.abort(err);
            reject(err);
          }, LIFECYCLE_HOOK_TIMEOUT_MS);
          ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      stop.removeEventListener("abort", onStop);
    }
  }

  /** A job failed (the worker's `failed` event): a retry warns, the last attempt logs an error. */
  onFailed(j: Job<LifecycleJob> | undefined, err: Error): void {
    if (!j) return;
    const fields = {
      jobId: j.id,
      deliveryId: j.data.deliveryId,
      attempt: j.attemptsMade,
      error: errMsg(err),
    };
    if (j.attemptsMade >= (j.opts.attempts ?? 1)) {
      this.log.error("lifecycle hook delivery failed; the sweeper offers it again", fields);
    } else this.log.warn("lifecycle hook delivery failed; retrying", fields);
  }
}

/**
 * The consumer of {@link LIFECYCLE_QUEUE}: {@link LifecycleHooks.process}. Worker role only
 * (`LifecycleHookWorkersModule`); built with `autorun: false`, started by the worker role after the
 * extensions loaded.
 */
@Injectable()
@Processor(LIFECYCLE_QUEUE, { autorun: false, concurrency: LIFECYCLE_CONCURRENCY })
export class LifecycleHooksProcessor extends WorkerHost<Worker<LifecycleJob>> {
  private readonly stopping = new AbortController();

  constructor(
    @Inject(LifecycleHooks) private readonly hooks: LifecycleHooks,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "error">,
  ) {
    super();
  }

  process(job: Job<LifecycleJob>): Promise<void> {
    return runJob(LIFECYCLE_QUEUE, job, () => this.hooks.process(job.data, this.stopping.signal));
  }

  /** Starts consuming (worker role, after the extensions loaded). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  /** Aborts the calls in flight and closes the worker. */
  async close(): Promise<void> {
    this.stopping.abort();
    await this.worker.close();
  }

  @OnWorkerEvent("failed")
  failed(job: Job<LifecycleJob> | undefined, err: Error): void {
    this.hooks.onFailed(job, err);
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("lifecycle hook worker error", { err });
  }
}

/** The lifecycle sweeper, every minute, once across replicas: {@link LifecycleHooks.sweep}. */
@Injectable()
export class LifecycleSweepJob {
  constructor(
    @Inject(LifecycleHooks) private readonly hooks: Pick<LifecycleHooks, "sweep">,
    @Inject(KernelConfigService) readonly config: KernelConfigService,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedInterval(LIFECYCLE_SWEEP_JOB, () => LIFECYCLE_SWEEP_PERIOD_MS)
  async run(): Promise<void> {
    const n = await this.hooks.sweep();
    if (n > 0) this.log.info("lifecycle hook deliveries offered again", { count: n });
  }
}

const LIFECYCLE_QUEUE_MODULE = QueueModule.registerQueue(LIFECYCLE_QUEUE);

/** Lifecycle hook delivery: recording and the producer, on every role. */
@Module({
  imports: [ExtensionsModule, LIFECYCLE_QUEUE_MODULE],
  providers: [LifecycleHooks],
  exports: [LifecycleHooks, LIFECYCLE_QUEUE_MODULE],
})
export class LifecycleHooksModule {}

/** The lifecycle queue's consumer; imported only by the worker role (`WorkerModule`). */
@Module({
  imports: [LifecycleHooksModule],
  providers: [LifecycleHooksProcessor],
  // the sweeper (`LifecycleSweepJob`, provided by `WorkerModule`) needs the service
  exports: [LifecycleHooksProcessor, LifecycleHooksModule],
})
export class LifecycleHookWorkersModule {}
