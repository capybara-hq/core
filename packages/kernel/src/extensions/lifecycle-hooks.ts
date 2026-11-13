import type { HookHandler, HookPayloads } from "@capybara-hq/plugin-sdk";
import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Worker } from "bullmq";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { runJob } from "../infra/queue/run-job.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ExtensionsModule } from "./extensions.module.js";
import { deepFreeze, errMsg, type LifecycleHook } from "./hooks.js";
import { ExtensionHost } from "./host.js";

/** Queue of lifecycle hook deliveries (no `:` in the name). */
export const LIFECYCLE_QUEUE = "cap-kernel-lifecycle";
/** The job name of every delivery (registered in `infra/outbox/registry.ts`). */
export const LIFECYCLE_JOB = "lifecycle";
/** One handler call's time limit. */
export const LIFECYCLE_HOOK_TIMEOUT_MS = 5000;
/** Concurrent deliveries per worker replica. */
const LIFECYCLE_CONCURRENCY = 4;

/** Job data: one mount's payload for one subscribing plugin. */
export interface LifecycleJob<K extends LifecycleHook = LifecycleHook> {
  mount: K;
  plugin: string;
  payload: HookPayloads[K];
}

/**
 * The deterministic job id of one delivery: the mount, the plugin and the payload's ids (no `:`;
 * kernel ids and plugin names carry none). Removing the same member, agent or org again while the
 * first delivery is still owed is the same job.
 */
export function lifecycleJobId<K extends LifecycleHook>(
  mount: K,
  plugin: string,
  payload: HookPayloads[K],
): string {
  const ids = Object.entries(payload)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, v]) => String(v));
  return ["lifecycle", mount.replaceAll(".", "-"), plugin, ...ids].join("-").replaceAll(":", "-");
}

/**
 * Plugins that subscribe to a lifecycle mount according to deployment state: the approved
 * permission snapshot declares the mount in `permissions.hooks`, and that approved version is the
 * one the deployment runs: an enabled install of that version, or a replica status row (not
 * `unloaded`) that loaded or still serves it (an upgrade pending approval keeps serving the
 * approved version; a config-declared plugin has only replica rows). A snapshot approved for
 * another version than the one installed or served does not count. Org enablement does not count
 * either: cleanup concerns data the plugin already holds (memory plugin spec §6.3). Sorted by name.
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
            .whereRef("i.version", "=", "s.version")
            .where("i.desired_state", "=", "enabled"),
        ),
        eb.exists(
          eb
            .selectFrom("extension_replica_status as r")
            .select(sql`1`.as("one"))
            .whereRef("r.plugin", "=", "s.plugin")
            .where("r.state", "<>", "unloaded")
            .where((r) =>
              r.or([
                r("r.version", "=", r.ref("s.version")),
                r("r.serving_version", "=", r.ref("s.version")),
              ]),
            ),
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
 * - **Owe** ({@link recordIn}): in the transaction that removes the member, the agent or the org,
 *   one outbox job per subscribing plugin ({@link queryLifecycleSubscribers}) on
 *   {@link LIFECYCLE_QUEUE}, under {@link lifecycleJobId}, with no `org_id` (it is the deletion's
 *   own cleanup work, transactional outbox spec §9); a rollback owes nothing. The outbox delivers
 *   it to BullMQ after the commit (registry: attempts and backoff).
 * - **Deliver** ({@link process}, worker role): the plugin's handlers loaded on this replica are
 *   called in turn (5 s each). Not loaded on this replica -> the job fails and is retried (another
 *   replica or a later attempt). Loaded without a handler -> dropped with a warning. Handlers get
 *   the plugin's platform deployment config (`call.config`), never an org's copy, so an org whose
 *   effective config is not valid still gets its cleanup. The last failed attempt logs an error.
 * Handlers must be idempotent (a delivery may repeat when a replica dies after the call).
 */
@Injectable()
export class LifecycleHooks {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    /** The loaded plugins' handlers (`hooks.handlers`) and whether a plugin is active here. */
    @Inject(ExtensionHost) private readonly host: Pick<ExtensionHost, "hooks" | "current">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  /**
   * Owes one delivery per subscribing plugin in the caller's transaction (`mandatory`); returns
   * the plugins.
   */
  @Transactional({ propagation: "mandatory" })
  async recordIn<K extends LifecycleHook>(mount: K, payload: HookPayloads[K]): Promise<string[]> {
    const plugins = await queryLifecycleSubscribers(this.kdb.db, mount);
    for (const plugin of plugins) {
      const data: LifecycleJob<K> = { mount, plugin, payload };
      await this.outbox.add({
        queue: LIFECYCLE_QUEUE,
        name: LIFECYCLE_JOB,
        jobId: lifecycleJobId(mount, plugin, payload),
        data,
      });
    }
    return plugins;
  }

  /** One delivery job (the consumer {@link LifecycleHooksProcessor} calls it). */
  async process(data: LifecycleJob, stop: AbortSignal): Promise<void> {
    const fields = { mount: data.mount, plugin: data.plugin };
    const handlers = this.host.hooks
      .lifecycleHandlers(data.mount)
      .filter((h) => h.plugin === data.plugin)
      .map((h) => h.handler as HookHandler<LifecycleHook>);
    if (handlers.length === 0) {
      if (this.host.current(data.plugin) === undefined) {
        // another replica or a later attempt may have it loaded
        throw new Error(`plugin ${data.plugin} is not loaded on this replica`);
      }
      this.log.warn("lifecycle hook delivery dropped: the plugin registered no handler", fields);
      return;
    }
    const payload = deepFreeze(structuredClone(data.payload)) as HookPayloads[LifecycleHook];
    for (const h of handlers) await this.call(h, payload, stop);
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
          // already aborted (the replica was stopping before the call): no abort event will fire
          if (ac.signal.aborted) reject(ac.signal.reason);
          else ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
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
      mount: j.data.mount,
      plugin: j.data.plugin,
      attempt: j.attemptsMade,
      error: errMsg(err),
    };
    if (j.attemptsMade >= (j.opts.attempts ?? 1)) {
      this.log.error("lifecycle hook delivery failed on its last attempt; given up", fields);
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

const LIFECYCLE_QUEUE_MODULE = QueueModule.registerQueue(LIFECYCLE_QUEUE);

/** Lifecycle hook delivery: owing the jobs, and the queue the outbox adds them to, on every role. */
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
  exports: [LifecycleHooksProcessor],
})
export class LifecycleHookWorkersModule {}
