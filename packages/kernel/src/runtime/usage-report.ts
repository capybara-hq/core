import type { HookHandler, Logger, UsageReportPayload } from "@capybara-hq/plugin-sdk";
import { DelayedError, Job, type JobsOptions, Queue, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { enabledExtensionsQuery } from "../extensions/enabled.js";
import { deepFreeze, errMsg, type HookRegistry } from "../extensions/hooks.js";
import { withJobContext } from "../log-context.js";
import { bullConnection } from "./run-queue.js";

/** Queue of `usage.report` deliveries (no `:` in the name). */
export const USAGE_REPORT_QUEUE = "cap-kernel-usage-report";

/** One job per `usage` event (no `:`: conversation ids are UUIDs, seq is a number). */
export const usageReportJobId = (conversationId: string, seq: number) =>
  `usage-${conversationId}-${seq}`;

/** Job data: ids only (the payload is read from the event log when the job runs). */
export interface UsageReportJob {
  conversationId: string;
  seq: number;
  /** Plugins not yet succeeded; absent = every subscriber (decided on the first attempt). */
  pending?: string[];
  /**
   * Targets dropped so far (plugin → why), accumulated across attempts (m-2): when the job would
   * otherwise complete it fails naming them, and `pending` is then exactly these plugins, so a
   * manual retry reaches only them (m-1). A later delivery to one of them removes it.
   */
  dropped?: Record<string, string>;
}

/** First attempt plus 5 retries (F11). */
export const USAGE_REPORT_ATTEMPTS = 6;
/** Retry backoff: 2 s, doubling (2, 4, 8, 16, 32 s). */
export const USAGE_REPORT_BACKOFF_MS = 2000;
/** Failed jobs (given up) are kept for inspection, at most {@link KEEP_FAILED_MAX} of them. */
const KEEP_FAILED_S = 7 * 86_400;
/** Upper bound on kept failed jobs (I-2): a long outage of a billing endpoint cannot grow Redis. */
const KEEP_FAILED_MAX = 100_000;
/** Warnings about a plugin that cannot take deliveries are logged at most once per this window. */
const WARN_WINDOW_MS = 60_000;
/**
 * Upper bound on kept finished jobs (Redis memory). At the default retention it only bites above
 * ~1.1 usage events per second sustained for a day; dedupe needs the jobs only for the sweeper overlap.
 */
const KEEP_COMPLETED_MAX = 100_000;

/** Maintenance job of the sweeper (no `:`), its scheduler id and period. */
export const USAGE_SWEEP_JOB = "usage-report-sweep";
export const USAGE_SWEEP_SCHEDULER_ID = "usage-report-sweep-every";
export const USAGE_SWEEP_EVERY_MS = 60_000;
/** The sweep leaves the newest events to the fast path (and to transactions still committing). */
export const USAGE_SWEEP_LAG_MS = 30_000;
/**
 * Each sweep re-scans this far behind the watermark: events whose transaction committed after a
 * previous sweep passed their `created_at` are still found. Far inside the dedupe window
 * (`hooks.usageReportKeepHours` ≥ 1 h), so re-enqueued events dedupe on the kept job.
 */
export const USAGE_SWEEP_OVERLAP_MS = 10 * 60_000;
const SWEEP_PAGE = 500;

const JOB = "usage-report";

export interface UsageReporterDeps {
  db: KernelDb;
  redisUrl: string;
  /**
   * The host's registry: handlers of the current local plugin generations (through inflight.run), and
   * `has("usage.report")`, the in-process check that lets `enqueue` skip all I/O without handlers.
   */
  hooks: Pick<HookRegistry, "handlers" | "has">;
  /**
   * Whether the plugin's current instance is active on this replica (I-2): an active instance that
   * registered no `usage.report` handler is not a subscriber, and its target is dropped. Absent: never.
   */
  isActive?(plugin: string): boolean;
  /**
   * Of these plugins, the ones no replica can serve right now (I-2): replicas report them (live
   * `extension_replica_status` rows) and none has them loaded. Their targets are dropped at once instead
   * of failing every attempt. See {@link queryUnservable}. Absent: none.
   */
  unservable?(plugins: readonly string[]): Promise<Set<string>>;
  /**
   * Plugins that subscribe to `usage.report`, from deployment state (approved manifests in PG), not from this replica's loaded handlers. With `orgId`: only those the
   * organization enabled. See {@link queryUsageSubscribers}.
   */
  subscribers(orgId?: string): Promise<Set<string>>;
  config: () => KernelConfig;
  log: Logger;
  /** Tests: retry policy (defaults {@link USAGE_REPORT_ATTEMPTS} / {@link USAGE_REPORT_BACKOFF_MS}). */
  retry?: { attempts: number; backoffMs: number };
}

/**
 * Plugins that subscribe to `usage.report` according to deployment state: an approved permission
 * snapshot that declares the `usage.report` hook, for a plugin the deployment still knows: an enabled
 * install, or a config-declared plugin with a replica status row that is not `unloaded`. With `orgId`, only plugins
 * the organization enabled (org config rows and required bootstrap plugins).
 */
export async function queryUsageSubscribers(db: KernelDb, orgId?: string): Promise<Set<string>> {
  let q = db
    .selectFrom("extension_permission_snapshots as s")
    .select("s.plugin")
    .where(sql<boolean>`s.permissions -> 'permissions' -> 'hooks' ? 'usage.report'`)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom("extension_installs as i")
            .select(sql`1`.as("one"))
            .whereRef("i.name", "=", "s.plugin")
            .where("i.desired_state", "=", "enabled"),
        ),
        // config-declared plugins still declared (and not unloaded) on some replica; installs are
        // covered by desired_state above (their replica rows linger as `unloaded` when disabled)
        eb.exists(
          eb
            .selectFrom("extension_replica_status as r")
            .select(sql`1`.as("one"))
            .whereRef("r.plugin", "=", "s.plugin")
            .where("r.source", "=", "config")
            .where("r.state", "<>", "unloaded"),
        ),
      ]),
    );
  if (orgId !== undefined) {
    q = q.where("s.plugin", "in", enabledExtensionsQuery(db, orgId));
  }
  return new Set((await q.execute()).map((r) => r.plugin));
}

/**
 * Of `plugins`, those that are **definitely** unservable right now (I-2, N-3): live replicas report
 * them (a `extension_replica_status` row with a heartbeat newer than `staleSeconds`), no live row is
 * `loaded` or still serves an older version (`serving_version`, e.g. an upgrade pending approval), and
 * the rows are not all `unloaded` (that is the state right after a re-enable, before the replicas
 * reconcile). A plugin with no live row at all is unknown too (slow to load, or a host without a
 * status store). Unknown plugins are never listed.
 */
export async function queryUnservable(
  db: KernelDb,
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

/**
 * The next `pending` set (m-2 fence): plugins that failed now, narrowed to what the stored job data
 * still lists. A plugin another (stalled-over) execution already delivered never comes back.
 */
export function narrowPending(stored: readonly string[] | undefined, failed: readonly string[]) {
  return stored === undefined ? [...failed] : failed.filter((p) => stored.includes(p));
}

/**
 * Reliable `usage.report` delivery (F11, P-17, R13). Every `usage` event written to the event log (chat
 * runs and full-run eval replays) is delivered at least once to every subscribing plugin.
 * - **Fast path:** `model-call` enqueues job `usage-<conversationId>-<seq>` right after writing the event
 *   (never awaited; an enqueue failure only logs). Skipped without I/O when this replica has no
 *   `usage.report` handler (M-2); the sweeper then offers the event.
 * - **Sweeper (R13):** a maintenance job (once across replicas, every minute) re-enqueues the `usage`
 *   events in `[watermark - 10 min, now - 30 s]` with the same job ids, so a lost fast-path enqueue is
 *   caught up and duplicates dedupe on the kept job (`hooks.usageReportKeepHours`).
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
 *   targets any more). The final failure logs an error (no audit); failed jobs are kept 7 days, at
 *   most 100 000. Each call runs through the instance's `inflight.run`, limited by `hooks.timeoutMs`;
 *   when this replica stops, in-flight calls are aborted and the job goes back to the queue without
 *   using up an attempt.
 * Handlers must be idempotent by `eventId` (`<conversationId>/<seq>`). Nothing is written to the event
 * log (never model-visible). Compaction calls log usage too (`purpose: "compaction"`) and are reported,
 * as are conversation title calls (`purpose: "title"`, no run: `runId` is "").
 * Single-step eval replays and judge requests log no usage: not reported (M7).
 */
export class UsageReporter {
  private queue: Queue<UsageReportJob> | undefined;
  private queueConn: Redis | undefined;
  private worker: Worker<UsageReportJob> | undefined;
  private workerConn: Redis | undefined;
  private closed = false;
  private readonly stopping = new AbortController();

  constructor(private readonly d: UsageReporterDeps) {}

  private jobOpts(conversationId: string, seq: number): JobsOptions {
    return {
      jobId: usageReportJobId(conversationId, seq),
      attempts: this.d.retry?.attempts ?? USAGE_REPORT_ATTEMPTS,
      backoff: { type: "exponential", delay: this.d.retry?.backoffMs ?? USAGE_REPORT_BACKOFF_MS },
      removeOnComplete: {
        age: this.d.config().hooks.usageReportKeepHours * 3600,
        count: KEEP_COMPLETED_MAX,
      },
      removeOnFail: { age: KEEP_FAILED_S, count: KEEP_FAILED_MAX },
    };
  }

  /**
   * Enqueues the delivery of one `usage` event. Returns without a job when no plugin subscribes.
   * Never throws: an enqueue failure (e.g. a Redis hiccup) only logs a warning; the sweeper catches up.
   */
  async enqueue(conversationId: string, seq: number): Promise<void> {
    if (this.closed) return;
    // M-2: no usage.report handler on this replica → no I/O at all. A plugin loaded only on other
    // replicas still gets the event: the sweeper re-offers it within about a minute and a half.
    if (!this.d.hooks.has("usage.report")) return;
    try {
      if ((await this.d.subscribers()).size === 0) return;
      await this.getQueue().add(JOB, { conversationId, seq }, this.jobOpts(conversationId, seq));
    } catch (err) {
      this.d.log.warn("cannot enqueue usage report", { conversationId, seq, err });
    }
  }

  /**
   * One sweep (R13): re-enqueues the `usage` events created in `[watermark - overlap, now - lag]` in
   * pages, then advances the watermark to `now - lag`. With no subscriber it only advances. The first
   * sweep starts at `now - lag - overlap`. Returns the number of events offered to the queue.
   */
  async sweep(opts: { now?: number } = {}): Promise<number> {
    // bounds and keyset as full-precision timestamp text (microseconds), computed with the DB clock
    // unless a test fixes "now" (m-a, m-c)
    const to =
      opts.now !== undefined
        ? new Date(opts.now - USAGE_SWEEP_LAG_MS).toISOString()
        : (
            await sql<{ to: string }>`SELECT (now() - make_interval(secs => ${
              USAGE_SWEEP_LAG_MS / 1000
            }))::text AS to`.execute(this.d.db)
          ).rows[0]?.to;
    if (to === undefined) return 0;
    const row = await this.d.db
      .selectFrom("usage_report_sweep")
      .select(sql<string>`watermark::text`.as("watermark"))
      .where("id", "=", 1)
      .executeTakeFirst();
    const watermark = row?.watermark ?? to;
    let offered = 0;
    if ((await this.d.subscribers()).size > 0) {
      let after: { at: string; conv: string; seq: string } | undefined;
      for (;;) {
        let q = this.d.db
          .selectFrom("conversation_events")
          .select(["conversation_id", "seq", sql<string>`created_at::text`.as("at")])
          .where("type", "=", "usage")
          .where(
            sql<boolean>`created_at >= ${watermark}::timestamptz - make_interval(secs => ${
              USAGE_SWEEP_OVERLAP_MS / 1000
            })`,
          )
          .where(sql<boolean>`created_at <= ${to}::timestamptz`);
        if (after) {
          q = q.where(
            sql<boolean>`(created_at, conversation_id, seq) > (${after.at}::timestamptz, ${after.conv}, ${after.seq}::bigint)`,
          );
        }
        const page = await q
          .orderBy("created_at")
          .orderBy("conversation_id")
          .orderBy("seq")
          .limit(SWEEP_PAGE)
          .execute();
        if (page.length > 0) {
          await this.getQueue().addBulk(
            page.map((r) => ({
              name: JOB,
              data: { conversationId: r.conversation_id, seq: Number(r.seq) },
              opts: this.jobOpts(r.conversation_id, Number(r.seq)),
            })),
          );
          offered += page.length;
        }
        const last = page.at(-1);
        if (!last || page.length < SWEEP_PAGE) break;
        after = { at: last.at, conv: last.conversation_id, seq: String(last.seq) };
      }
    }
    await this.d.db
      .insertInto("usage_report_sweep")
      .values({ id: 1, watermark: sql<Date>`${to}::timestamptz` as unknown as Date })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          watermark: sql`GREATEST(usage_report_sweep.watermark, excluded.watermark)`,
          updated_at: sql`now()`,
        }),
      )
      .execute();
    return offered;
  }

  /** Starts the worker (worker role only). Job lock and stalled detection follow the run queue. */
  startWorker(): void {
    if (this.worker || this.closed) return;
    const { jobLockMs, stalledIntervalMs } = this.d.config().runtime;
    // the queue exists before any job runs: in-flight jobs fence and requeue through it, even on a
    // replica that never enqueued (m-b)
    this.getQueue();
    this.workerConn = bullConnection(this.d.redisUrl, this.d.log);
    this.worker = new Worker<UsageReportJob>(
      USAGE_REPORT_QUEUE,
      (j, t) => withJobContext(USAGE_REPORT_QUEUE, j, () => this.process(j, t)),
      {
        connection: this.workerConn,
        concurrency: this.d.config().hooks.usageReportConcurrency,
        lockDuration: jobLockMs,
        stalledInterval: stalledIntervalMs,
        maxStalledCount: 3,
      },
    );
    this.worker.on("error", (err) => this.d.log.error("usage report worker error", { err }));
    this.worker.on("failed", (j, err) => {
      if (!j || err instanceof DelayedError || err.name === "DelayedError") return;
      // a definite drop (N-3) was already warned about (throttled); the failed job is the trace
      if (err instanceof UnrecoverableError || err.name === "UnrecoverableError") return;
      const final = j.attemptsMade >= (j.opts.attempts ?? 1);
      const fields = {
        jobId: j.id,
        conversationId: j.data.conversationId,
        seq: j.data.seq,
        pending: j.data.pending,
        attempt: j.attemptsMade,
        error: err.message,
      };
      if (final) this.d.log.error("usage report given up after retries", fields);
      else this.d.log.warn("usage report attempt failed; retrying", fields);
    });
  }

  /** Stops the worker (in-flight calls are aborted, their jobs requeued) and the queue. */
  async stop(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    const w = this.worker;
    this.worker = undefined;
    // the worker first: its in-flight jobs still use the queue to fence and requeue
    await w?.close().catch(() => {});
    const q = this.queue;
    this.queue = undefined;
    await q?.close().catch(() => {});
    for (const c of [this.workerConn, this.queueConn]) {
      if (c) await c.quit().catch(() => c.disconnect());
    }
    this.workerConn = undefined;
    this.queueConn = undefined;
  }

  private getQueue(): Queue<UsageReportJob> {
    if (!this.queue) {
      if (this.closed) throw new Error("usage report queue is closed");
      this.queueConn = bullConnection(this.d.redisUrl, this.d.log);
      this.queue = new Queue<UsageReportJob>(USAGE_REPORT_QUEUE, { connection: this.queueConn });
      this.queue.on("error", (err) => this.d.log.error("usage report queue error", { err }));
    }
    return this.queue;
  }

  /** The payload of one usage event, read from the log; null when the event no longer exists. */
  private async payloadOf(conversationId: string, seq: number): Promise<UsageReportPayload | null> {
    const row = await this.d.db
      .selectFrom("conversation_events as e")
      .innerJoin("conversations as c", "c.id", "e.conversation_id")
      .leftJoin("runs as r", "r.id", "e.run_id")
      // a sub-agent's run: its dispatch says where it was dispatched from (spec §11)
      .leftJoin("subagent_dispatches as sd", "sd.child_run_id", "e.run_id")
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
        "sd.parent_conversation_id",
        "sd.parent_run_id",
        "sd.parent_call_id",
      ])
      .where("e.conversation_id", "=", conversationId)
      .where("e.seq", "=", String(seq))
      .executeTakeFirst();
    if (row?.type !== "usage") return null;
    const p = row.payload as {
      purpose?: "compaction" | "title";
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
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
      ...(row.parent_conversation_id !== null &&
        row.parent_run_id !== null &&
        row.parent_call_id !== null && {
          parent: {
            conversationId: row.parent_conversation_id,
            runId: row.parent_run_id,
            callId: row.parent_call_id,
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
    const fresh = j.id === undefined ? undefined : await Job.fromId(this.getQueue(), j.id);
    const data = fresh?.data as UsageReportJob | undefined;
    const stored = data?.pending ?? j.data.pending;
    const storedDropped = data?.dropped ?? j.data.dropped ?? {};
    const allowed = stored === undefined ? undefined : [...stored, ...Object.keys(storedDropped)];
    const keep = [...dropped].filter(([p]) => allowed === undefined || allowed.includes(p));
    const out: UsageReportJob = {
      conversationId: j.data.conversationId,
      seq: j.data.seq,
      pending: narrowPending(allowed, next),
      ...(keep.length > 0 && { dropped: Object.fromEntries(keep) }),
    };
    await j.updateData(out);
    j.data = out;
  }

  private async process(j: Job<UsageReportJob>, token: string | undefined): Promise<void> {
    const { conversationId, seq } = j.data;
    const payload = await this.payloadOf(conversationId, seq);
    if (payload === null) return; // conversation deleted meanwhile: nothing to report
    const subscribers = await this.d.subscribers(payload.orgId);
    if (j.data.pending === undefined) {
      // first attempt: the targets come from deployment state, recorded so later attempts (on any
      // replica) deliver exactly the plugins that have not succeeded yet
      const targets = [...subscribers];
      await j.updateData({ conversationId, seq, pending: targets });
      j.data.pending = targets;
    }
    // plugins the organization disabled meanwhile are dropped (not a failure)
    const targets = (j.data.pending ?? []).filter((p) => subscribers.has(p));
    if (targets.length === 0) return;
    const byPlugin = new Map<string, HookHandler<"usage.report">[]>();
    for (const h of this.d.hooks.handlers("usage.report")) {
      byPlugin.set(h.plugin, [...(byPlugin.get(h.plugin) ?? []), h.handler]);
    }
    const frozen = deepFreeze(structuredClone(payload));
    const timeoutMs = this.d.config().hooks.timeoutMs;
    const results = await Promise.allSettled(
      targets.map(async (plugin) => {
        const handlers = byPlugin.get(plugin);
        if (!handlers || handlers.length === 0) {
          throw new Undeliverable(plugin, this.d.isActive?.(plugin) ? "no_handler" : "not_loaded");
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
      failed.push(plugin);
      if (!this.stopping.signal.aborted) {
        this.d.log.warn("usage.report delivery to a plugin failed", {
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
        ? await this.unservable(notHere)
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

  /** {@link UsageReporterDeps.unservable}; a lookup failure counts as "unknown" (keep retrying). */
  private async unservable(plugins: string[]): Promise<Set<string>> {
    if (!this.d.unservable) return new Set();
    try {
      return await this.d.unservable(plugins);
    } catch (err) {
      this.d.log.warn("cannot read plugin replica status for usage.report", { err });
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
      this.getQueue();
      const key = `capk:usage-warn:${plugin}:${kind}`;
      first = (await this.queueConn?.set(key, "1", "PX", WARN_WINDOW_MS, "NX")) !== null;
    } catch {
      // Redis unavailable: log anyway rather than hiding it
    }
    if (first) this.d.log.warn(msg, fields);
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
