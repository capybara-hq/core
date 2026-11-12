import type { HookHandler, Logger, UsageReportPayload } from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import { DelayedError, Job, type Queue, UnrecoverableError, type Worker } from "bullmq";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import {
  deepFreeze,
  errMsg,
  HookNeedsConfigError,
  type HookRegistry,
} from "../extensions/hooks.js";
import { ExtensionHost } from "../extensions/host.js";
import { STALE_RECONCILE_PERIODS } from "../extensions/lifecycle-topics.js";
import { queryUsageSubscribers } from "../extensions/usage-subscribers.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { deliveryRowOfChildRun } from "./subagents/child.js";
import {
  USAGE_REPORT_QUEUE,
  type UsageReportJob,
  UsageReportJobsModule,
} from "./usage-report-jobs.js";

export { queryUsageSubscribers } from "../extensions/usage-subscribers.js";
export {
  modelUsageJobId,
  USAGE_REPORT_JOB,
  USAGE_REPORT_QUEUE,
  type UsageReportJob,
  UsageReportJobs,
  UsageReportJobsModule,
  usageReportJobId,
} from "./usage-report-jobs.js";

/** Warnings about a plugin that cannot take deliveries are logged at most once per this window. */
const WARN_WINDOW_MS = 60_000;

/**
 * Of `plugins`, those that are **definitely** unservable right now (I-2, N-3): live replicas report
 * them (a `extension_replica_status` row with a heartbeat newer than `staleSeconds`), no live row is
 * `loaded` or still serves an older version (`serving_version`, e.g. an upgrade pending approval), and
 * the rows are not all `unloaded` (that is the state right after a re-enable, before the replicas
 * reconcile). A plugin with no live row at all is unknown too (slow to load, or a host without a
 * status store). Unknown plugins are never listed.
 */
export async function queryUnservable(
  db: KernelSchemaDb,
  plugins: readonly string[],
  staleSeconds: number,
): Promise<Set<string>> {
  if (plugins.length === 0) return new Set();
  const rows = await db
    .selectFrom("extension_replica_status")
    .select("plugin")
    .where("plugin", "in", [...plugins])
    .where("heartbeat_at", ">", sql<Date>`now() - make_interval(secs => ${staleSeconds})`)
    .groupBy("plugin")
    .having(sql<boolean>`bool_or(state = 'loaded' OR serving_version IS NOT NULL)`, "=", false)
    .having(sql<boolean>`bool_and(state = 'unloaded')`, "=", false)
    .execute();
  return new Set(rows.map((r) => r.plugin));
}

/** `" dropped: x (why), y (why)"`, or empty. */
const droppedNote = (dropped: ReadonlyMap<string, string>): string =>
  dropped.size === 0
    ? ""
    : ` dropped: ${[...dropped].map(([p, why]) => `${p} (${why})`).join(", ")}`;

/** A target this replica cannot deliver to: not loaded here, or loaded without a handler. */
class Undeliverable extends Error {
  constructor(
    readonly plugin: string,
    readonly why: "not_loaded" | "no_handler",
  ) {
    super(
      why === "no_handler"
        ? `plugin ${plugin} is loaded on this replica but registered no usage.report handler`
        : `plugin ${plugin} has no usage.report handler on this replica`,
    );
    this.name = "Undeliverable";
  }
}

/** A job's identity: its `usage` event or its `model_usage` row. */
const keyOf = (d: UsageReportJob): UsageReportJob =>
  d.usageId !== undefined
    ? { usageId: d.usageId }
    : { conversationId: d.conversationId, seq: d.seq };

/**
 * The next `pending` set (m-2 fence): plugins that failed now, narrowed to what the stored job data
 * still lists. A plugin another (stalled-over) execution already delivered never comes back.
 */
export function narrowPending(stored: readonly string[] | undefined, failed: readonly string[]) {
  return stored === undefined ? [...failed] : failed.filter((p) => stored.includes(p));
}

/**
 * Reliable `usage.report` delivery (F11, P-17, transactional outbox spec §8.1). Every `usage` event
 * written to the event log (chat runs and full-run eval replays) is delivered at least once to every
 * subscribing plugin.
 * - **Owed with the usage:** the transaction that writes a `usage` event (`StepLog`'s step writes, a
 *   title's writes) or a `model_usage` row also writes the outbox row of job
 *   `usage-<conversationId>-<seq>` / `usage-model-<rowId>` (`UsageReportJobs`), while the deployment
 *   has at least one subscriber (`UsageSubscribers`: from PG, whatever this replica loaded; cached
 *   30 s per replica, cleared on `PLUGINS_CHANGED`). The outbox fast path adds the job after the
 *   commit and the relay catches up what it did not. Usage written while no plugin subscribed is
 *   never reported: a subscription starts when the plugin is enabled.
 * - **Worker** (worker role, `hooks.usageReportConcurrency` per replica): reads the payload from the log
 *   at execution time (the `usage` event, the conversation with `kind`, the run). On the first attempt
 *   the targets are the deployment's subscribers the organization enabled (I-2: not this replica's
 *   handlers), written into `pending`; plugins run concurrently (`allSettled`); failed ones stay in
 *   `pending` and are retried (5 retries, 2 s doubling). A plugin not loaded on this replica (or
 *   between generations) is a failure, so another replica or a later attempt delivers it. On the
 *   last attempt it is dropped only when it is definitely unservable ({@link queryUnservable});
 *   otherwise the job fails as usual. A plugin loaded here that registered no handler is dropped at
 *   once (I-2). A drop (N-3) is never silent: after delivering to the other targets the job ends
 *   failed with an `UnrecoverableError` whose failedReason names the dropped plugins, plus a
 *   throttled warning. Plugins the organization disabled by delivery time are dropped silently (not
 *   targets any more). The final failure logs an error (no audit); finished jobs are kept a day and
 *   failed jobs 7 days, at most 100 000 each (the outbox registry's `usage-report` options). Each
 *   call runs through the instance's `inflight.run`, limited by `hooks.timeoutMs`; when this
 *   replica stops, in-flight calls are aborted and the job goes back to the queue without using up
 *   an attempt.
 * Handlers must be idempotent by `eventId` (`<conversationId>/<seq>`, or a `model_usage` row id).
 * Nothing is written to the event log (never model-visible). Compaction calls log usage too (`purpose: "compaction"`) and are reported,
 * as are conversation title calls (`purpose: "title"`, no run: `runId` is "") and `WebFetch`
 * extraction calls (`purpose: "web_fetch"`).
 * Single-step eval replays and judge requests log no usage: not reported (M7).
 * - **Model usage outside conversations** (spec B §5.4): each `ctx.models.embed` call writes a
 *   `model_usage` row and owes job `usage-model-<rowId>` with it; the payload
 *   (`purpose: "embedding"`, `eventId` = the row id, the calling `extension`, no conversation fields)
 *   is read from the row when the job runs, and the row's `reported_at` is set once nothing is left
 *   to deliver; a job that gives up after its last attempt sets `report_failed_at`. A row with
 *   `reported_at IS NULL` is not necessarily pending: no job is owed when no enabled extension
 *   subscribed to `usage.report` at the time of the call, and such a row is never reported.
 */
@Injectable()
export class UsageReporter {
  private worker: Worker<UsageReportJob> | undefined;
  private closed = false;
  private readonly stopping = new AbortController();

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(getQueueToken(USAGE_REPORT_QUEUE)) private readonly queue: Queue<UsageReportJob>,
    /**
     * The host's hook registry: handlers of the current local plugin generations (through
     * inflight.run); and whether a plugin's current instance is active here.
     */
    @Inject(ExtensionHost) private readonly host: Pick<ExtensionHost, "hooks" | "current">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    /** The warning throttle's markers (`capk:usage-warn:<plugin>:<kind>`, SET NX PX). */
    @Inject(LockService) private readonly locks: Pick<LockService, "lease">,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
  ) {
    queue.on("error", (err) => this.log.error("usage report queue error", { err }));
  }

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  private get hooks(): Pick<HookRegistry, "handlers"> {
    return this.host.hooks;
  }

  /**
   * Whether the plugin's current instance is active on this replica (I-2): an active instance that
   * registered no `usage.report` handler is not a subscriber, and its target is dropped.
   */
  isActive(plugin: string): boolean {
    return this.host.current(plugin) !== undefined;
  }

  /**
   * Of these plugins, the ones no replica can serve right now (I-2): replicas report them (live
   * `extension_replica_status` rows) and none has them loaded. Their targets are dropped at once
   * instead of failing every attempt. See {@link queryUnservable}.
   */
  unservable(plugins: readonly string[]): Promise<Set<string>> {
    return queryUnservable(
      this.db,
      plugins,
      STALE_RECONCILE_PERIODS * this.config.get().extensionHost.reconcileIntervalSeconds,
    );
  }

  /**
   * Plugins that subscribe to `usage.report`, from deployment state (approved manifests in PG),
   * not from this replica's loaded handlers. With `orgId`: only those the organization enabled.
   * See {@link queryUsageSubscribers}.
   */
  subscribers(orgId?: string): Promise<Set<string>> {
    return queryUsageSubscribers(this.db, orgId);
  }

  /**
   * Starts consuming (worker role only): `worker` is the `@Processor` worker of
   * {@link USAGE_REPORT_QUEUE} (built with the run queue's job lock and stalled detection).
   */
  startWorker(worker: Worker<UsageReportJob>): void {
    if (this.worker || this.closed) return;
    this.worker = worker;
    void worker.run().catch((err) => this.log.error("usage report worker error", { err }));
  }

  /** The worker's `error` event. */
  onError(err: Error): void {
    this.log.error("usage report worker error", { err });
  }

  /** A job failed (the worker's `failed` event): logs retries and the final failure. */
  onFailed(j: Job<UsageReportJob> | undefined, err: Error): void {
    if (!j || err instanceof DelayedError || err.name === "DelayedError") return;
    // a definite drop (N-3) was already warned about (throttled); the failed job is the trace
    if (err instanceof UnrecoverableError || err.name === "UnrecoverableError") return;
    const final = j.attemptsMade >= (j.opts.attempts ?? 1);
    const fields = {
      jobId: j.id,
      ...(j.data.usageId !== undefined
        ? { usageId: j.data.usageId }
        : { conversationId: j.data.conversationId, seq: j.data.seq }),
      pending: j.data.pending,
      attempt: j.attemptsMade,
      error: err.message,
    };
    if (final) {
      this.log.error("usage report given up after retries", fields);
      void this.markFailed(j.data);
    } else this.log.warn("usage report attempt failed; retrying", fields);
  }

  /**
   * Stops: in-flight calls are aborted (their jobs requeued) and the worker closes. The queue
   * itself closes with the application.
   */
  async stop(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    const w = this.worker;
    this.worker = undefined;
    await w?.close().catch(() => {});
  }

  /** The payload of a job: a `usage` event's or a `model_usage` row's; null when it is gone. */
  private payloadOfJob(data: UsageReportJob): Promise<UsageReportPayload | null> {
    return data.usageId !== undefined
      ? this.payloadOfUsage(data.usageId)
      : this.payloadOf(data.conversationId, data.seq);
  }

  /**
   * The payload of one `model_usage` row (spec B §5.4): purpose `embedding`, the calling extension,
   * no conversation fields; `eventId` is the row id. Null when the row no longer exists.
   */
  private async payloadOfUsage(id: string): Promise<UsageReportPayload | null> {
    const row = await this.db
      .selectFrom("model_usage")
      .select(["id", "org_id", "extension", "provider", "model", "input_tokens", "occurred_at"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    return {
      eventId: row.id,
      purpose: "embedding",
      orgId: row.org_id,
      extension: row.extension,
      provider: row.provider,
      model: row.model,
      usage: {
        inputTokens: row.input_tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      occurredAt: new Date(row.occurred_at).toISOString(),
    };
  }

  /** A `model_usage` job is done (delivered, or nothing left to deliver to): marks the row. */
  private async markReported(data: UsageReportJob): Promise<void> {
    if (data.usageId === undefined) return;
    await this.db
      .updateTable("model_usage")
      .set({ reported_at: sql<Date>`now()` as unknown as Date })
      .where("id", "=", data.usageId)
      .where("reported_at", "is", null)
      .execute();
  }

  /** A `model_usage` job gave up after its last attempt: the row records it. */
  private async markFailed(data: UsageReportJob): Promise<void> {
    if (data.usageId === undefined) return;
    try {
      await this.db
        .updateTable("model_usage")
        .set({ report_failed_at: sql<Date>`now()` as unknown as Date })
        .where("id", "=", data.usageId)
        .where("reported_at", "is", null)
        .execute();
    } catch (err) {
      this.log.warn("cannot mark a model usage report as given up", { usageId: data.usageId, err });
    }
  }

  /** The payload of one usage event, read from the log; null when the event no longer exists. */
  private async payloadOf(conversationId: string, seq: number): Promise<UsageReportPayload | null> {
    const row = await this.db
      .selectFrom("conversation_events as e")
      .innerJoin("conversations as c", "c.id", "e.conversation_id")
      .leftJoin("runs as r", "r.id", "e.run_id")
      .select([
        "e.payload",
        "e.run_id",
        "e.created_at",
        "e.type",
        "c.org_id",
        "c.agent_id",
        "c.account_id",
        "c.kind",
        "r.trigger_account_id",
      ])
      .where("e.conversation_id", "=", conversationId)
      .where("e.seq", "=", String(seq))
      .executeTakeFirst();
    if (row?.type !== "usage") return null;
    const p = row.payload as {
      purpose?: "compaction" | "title" | "web_fetch";
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    // a sub-agent's run: where it was dispatched from (spec §11), its own dispatch, else (a wake
    // run nobody dispatched, agent map spec §5.3) its conversation's latest one
    const parent =
      row.kind === "subagent" && row.run_id !== null
        ? await deliveryRowOfChildRun(this.db, row.run_id)
        : null;
    return {
      eventId: `${conversationId}/${seq}`,
      purpose: p.purpose ?? "step",
      orgId: row.org_id,
      accountId: row.trigger_account_id ?? row.account_id,
      agentId: row.agent_id,
      conversationId,
      // a sub-agent's calls report "chat" (spec §11: the SDK union is not widened)
      conversationKind: row.kind === "eval" ? "eval" : "chat",
      runId: row.run_id ?? "",
      ...(parent !== null && {
        parent: {
          conversationId: parent.parentConversationId,
          runId: parent.parentRunId,
          callId: parent.parentCallId,
        },
      }),
      provider: p.provider,
      model: p.model,
      usage: {
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        cacheReadTokens: p.cacheReadTokens,
        cacheWriteTokens: p.cacheWriteTokens,
      },
      occurredAt: new Date(row.created_at).toISOString(),
    };
  }

  /**
   * Writes the next `pending` set and the accumulated drops, fenced against a concurrent
   * (stalled-over) execution (m-2 fence): only plugins the stored data still lists as pending or
   * dropped can stay, so a plugin another execution delivered never comes back.
   */
  private async writePending(
    j: Job<UsageReportJob>,
    next: string[],
    dropped: ReadonlyMap<string, string>,
  ): Promise<void> {
    const fresh = j.id === undefined ? undefined : await Job.fromId(this.queue, j.id);
    const data = fresh?.data as UsageReportJob | undefined;
    const stored = data?.pending ?? j.data.pending;
    const storedDropped = data?.dropped ?? j.data.dropped ?? {};
    const allowed = stored === undefined ? undefined : [...stored, ...Object.keys(storedDropped)];
    const keep = [...dropped].filter(([p]) => allowed === undefined || allowed.includes(p));
    const out: UsageReportJob = {
      ...keyOf(j.data),
      pending: narrowPending(allowed, next),
      ...(keep.length > 0 && { dropped: Object.fromEntries(keep) }),
    };
    await j.updateData(out);
    j.data = out;
  }

  /** One delivery job (the `@Processor` of {@link USAGE_REPORT_QUEUE} calls it). */
  async process(j: Job<UsageReportJob>, token: string | undefined): Promise<void> {
    const payload = await this.payloadOfJob(j.data);
    // conversation (or org) deleted meanwhile: nothing to report
    if (payload === null) return;
    const subscribers = await this.subscribers(payload.orgId);
    if (j.data.pending === undefined) {
      // first attempt: the targets come from deployment state, recorded so later attempts (on any
      // replica) deliver exactly the plugins that have not succeeded yet
      const targets = [...subscribers];
      await j.updateData({ ...keyOf(j.data), pending: targets });
      j.data.pending = targets;
    }
    // plugins the organization disabled meanwhile are dropped (not a failure)
    const targets = (j.data.pending ?? []).filter((p) => subscribers.has(p));
    if (targets.length === 0) {
      await this.markReported(j.data);
      return;
    }
    const byPlugin = new Map<string, HookHandler<"usage.report">[]>();
    for (const h of this.hooks.handlers("usage.report")) {
      byPlugin.set(h.plugin, [...(byPlugin.get(h.plugin) ?? []), h.handler]);
    }
    const frozen = deepFreeze(structuredClone(payload));
    const timeoutMs = this.config.get().hooks.timeoutMs;
    const results = await Promise.allSettled(
      targets.map(async (plugin) => {
        const handlers = byPlugin.get(plugin);
        if (!handlers || handlers.length === 0) {
          throw new Undeliverable(plugin, this.isActive(plugin) ? "no_handler" : "not_loaded");
        }
        for (const h of handlers) await this.call(h, frozen, timeoutMs);
      }),
    );
    const failed: string[] = [];
    const notHere: string[] = [];
    /** Definite drops (N-3): plugin → why; they end the job as failed, with no further retries. */
    const dropped = new Map<string, string>();
    results.forEach((r, i) => {
      if (r.status === "fulfilled") return;
      const plugin = targets[i] as string;
      if (r.reason instanceof Undeliverable) {
        // I-2: loaded here without a handler: not a subscriber (declared but never registered, or
        // a downgrade); dropped, not retried
        if (r.reason.why === "no_handler")
          dropped.set(plugin, "registered no usage.report handler");
        else notHere.push(plugin);
        return;
      }
      // layering spec A §6: the extension's effective config is not valid in this organization, so
      // it is not called there (an observe hook skipped); dropped, not retried
      if (r.reason instanceof HookNeedsConfigError) {
        dropped.set(plugin, "needs configuration in this organization");
        return;
      }
      failed.push(plugin);
      if (!this.stopping.signal.aborted) {
        this.log.warn("usage.report delivery to a plugin failed", {
          plugin,
          eventId: payload.eventId,
          error: errMsg(r.reason),
        });
      }
    });
    // not loaded here: another replica or a later attempt may serve it (retry). On the last attempt a
    // target is dropped only when it is definitely unservable; unknown ones fail the job as before.
    const final = j.attemptsMade + 1 >= (j.opts.attempts ?? 1);
    const gone =
      final && notHere.length > 0 && !this.stopping.signal.aborted
        ? await this.unservableOrNone(notHere)
        : new Set<string>();
    for (const plugin of notHere) {
      if (gone.has(plugin)) dropped.set(plugin, "no replica has it loaded");
      else failed.push(plugin);
    }
    // m-2: drops accumulate across attempts (minus plugins delivered now), so a drop on an attempt
    // that also had a transient failure still fails the job once the rest succeeds
    const delivered = new Set(targets.filter((_, i) => results[i]?.status === "fulfilled"));
    const allDropped = new Map(
      // (a plugin the organization disabled meanwhile is no target any more: not traced)
      Object.entries(j.data.dropped ?? {}).filter(([p]) => !delivered.has(p) && subscribers.has(p)),
    );
    for (const [p, why] of dropped) allDropped.set(p, why);
    if (failed.length > 0) {
      await this.writePending(j, failed, allDropped);
      if (this.stopping.signal.aborted) {
        // shutdown is not the plugin's fault: back to the queue without using up an attempt (m-3)
        await j.moveToDelayed(Date.now(), token);
        throw new DelayedError();
      }
      throw new Error(`usage.report failed for: ${failed.join(", ")}${droppedNote(dropped)}`);
    }
    // m-1: pending = the dropped plugins only, so a manual retry reaches them and never the
    // plugins already served
    await this.writePending(j, [...allDropped.keys()], allDropped);
    // delivered to every target still servable (a definite drop is final too): the row is done
    await this.markReported(j.data);
    const traced = new Map([...allDropped].filter(([p]) => j.data.dropped?.[p] !== undefined));
    if (traced.size === 0) return;
    // N-3: a definite drop leaves a durable trace: the job ends failed (kept under the failed-job
    // cap, visible in queue tooling) with the dropped plugins in failedReason; no more retries
    for (const [plugin, reason] of dropped) {
      void this.warnOnce(plugin, "dropped", "usage.report target dropped", {
        plugin,
        eventId: payload.eventId,
        reason,
      });
    }
    throw new UnrecoverableError(`usage.report delivered to the rest;${droppedNote(traced)}`);
  }

  /** {@link unservable}; a lookup failure counts as "unknown" (keep retrying). */
  private async unservableOrNone(plugins: string[]): Promise<Set<string>> {
    try {
      return await this.unservable(plugins);
    } catch (err) {
      this.log.warn("cannot read plugin replica status for usage.report", { err });
      return new Set();
    }
  }

  /** Logs a warning at most once per plugin and kind per minute (Redis key with a TTL). */
  private async warnOnce(
    plugin: string,
    kind: string,
    msg: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    let first = true;
    try {
      first = await this.locks.lease(`capk:usage-warn:${plugin}:${kind}`, "1", WARN_WINDOW_MS);
    } catch {
      // Redis unavailable: log anyway rather than hiding it
    }
    if (first) this.log.warn(msg, fields);
  }

  /** One handler call with its own signal (timeout or replica stop aborts it); rejects on either. */
  private async call(
    h: HookHandler<"usage.report">,
    payload: UsageReportPayload,
    timeoutMs: number,
  ): Promise<void> {
    const ac = new AbortController();
    const onStop = () => ac.abort(new Error("replica stopping"));
    if (this.stopping.signal.aborted) onStop();
    else this.stopping.signal.addEventListener("abort", onStop, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => h(payload, ac.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ac.abort(new Error(`timed out after ${timeoutMs} ms`));
            reject(new Error(`timed out after ${timeoutMs} ms`));
          }, timeoutMs);
          ac.signal.addEventListener("abort", () => reject(ac.signal.reason), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.stopping.signal.removeEventListener("abort", onStop);
    }
  }
}

/** The usage report queue (one instance per process). */
const USAGE_REPORT_QUEUE_MODULE = QueueModule.registerQueue(USAGE_REPORT_QUEUE);

/**
 * `usage.report` delivery: the producer (`UsageReportJobs`) and the queue on every role; the
 * consumer's `@Processor` on the worker role (`WorkerModule`).
 */
@Module({
  imports: [ExtensionsModule, UsageReportJobsModule, USAGE_REPORT_QUEUE_MODULE],
  providers: [UsageReporter],
  exports: [UsageReporter, UsageReportJobsModule, USAGE_REPORT_QUEUE_MODULE],
})
export class UsageReportModule {}
