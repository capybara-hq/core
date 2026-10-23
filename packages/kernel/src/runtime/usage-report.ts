import type { HookHandler, Logger, UsageReportPayload } from "@capybara-hq/plugin-sdk";
import { type Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { deepFreeze, errMsg, type HookRegistry } from "../plugins/hooks.js";
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
  /** Plugins not yet succeeded; absent = every enabled plugin with a `usage.report` handler. */
  pending?: string[];
}

/** First attempt plus 5 retries (F11). */
export const USAGE_REPORT_ATTEMPTS = 6;
/** Retry backoff: 2 s, doubling (2, 4, 8, 16, 32 s). */
export const USAGE_REPORT_BACKOFF_MS = 2000;
/** Completed jobs are kept this long so re-enqueueing the same event (e.g. a resumed step) dedupes. */
const KEEP_COMPLETED_S = 86_400;
/** Failed jobs (given up) are kept for inspection. */
const KEEP_FAILED_S = 7 * 86_400;

const job = "usage-report";

export interface UsageReporterDeps {
  db: KernelDb;
  redisUrl: string;
  /** The host's registry: handlers of the current plugin generations, each call through inflight.run. */
  hooks: Pick<HookRegistry, "handlers">;
  /** Plugins the organization has enabled (checked at delivery time, P-17). */
  enabledPlugins(orgId: string): Promise<Set<string>>;
  config: () => KernelConfig;
  log: Logger;
}

/**
 * Reliable `usage.report` delivery (F11, P-17). Every `usage` event written to the event log (chat runs
 * and full-run eval replays) is enqueued once as job `usage-<conversationId>-<seq>`; the worker (worker
 * role only, `hooks.usageReportConcurrency` per replica) reads the payload from the log when the job
 * runs: the `usage` event, the conversation (org, agent, `kind`) and the run (trigger account).
 *
 * Delivery is per plugin and at least once: each enabled plugin with a `usage.report` handler gets
 * the event; when some fail, only those are written back to `pending` and retried (up to 5 retries,
 * 2 s doubling). Handlers must be idempotent by `eventId` (`<conversationId>/<seq>`).
 * - The handler of a plugin's **current** generation is used (a job enqueued before an upgrade goes
 *   to the new instance). A pending plugin with no current handler on this replica (unloaded, or not
 *   loaded here yet) counts as a failure: retried with the same backoff, then given up with an error
 *   log (no audit entry).
 * - A plugin the organization disabled by delivery time is dropped from `pending` (not a failure).
 * - Each call is limited by `hooks.timeoutMs`, runs through the instance's `inflight.run` and is
 *   aborted when this replica stops (the job is then retried by any replica).
 * Nothing is written to the event log: usage reports are never model-visible. No in-process state
 * beyond this replica's own queue / worker connections.
 *
 * Single-step eval replays and judge requests write no `usage` event, so they are not reported (M7).
 */
export class UsageReporter {
  private queue: Queue<UsageReportJob> | undefined;
  private queueConn: Redis | undefined;
  private worker: Worker<UsageReportJob> | undefined;
  private workerConn: Redis | undefined;
  private closed = false;
  private readonly stopping = new AbortController();

  constructor(private readonly d: UsageReporterDeps) {}

  /**
   * Enqueues the delivery of one `usage` event. Returns immediately when no plugin has a `usage.report`
   * handler. Never throws: an enqueue failure (e.g. a Redis hiccup) only logs a warning, so it cannot
   * fail the run.
   */
  async enqueue(conversationId: string, seq: number): Promise<void> {
    if (this.closed || this.d.hooks.handlers("usage.report").length === 0) return;
    try {
      await this.getQueue().add(
        job,
        { conversationId, seq },
        {
          jobId: usageReportJobId(conversationId, seq),
          attempts: USAGE_REPORT_ATTEMPTS,
          backoff: { type: "exponential", delay: USAGE_REPORT_BACKOFF_MS },
          removeOnComplete: { age: KEEP_COMPLETED_S },
          removeOnFail: { age: KEEP_FAILED_S },
        },
      );
    } catch (err) {
      this.d.log.warn("cannot enqueue usage report", { conversationId, seq, err });
    }
  }

  /** Starts the worker (worker role only). Job lock and stalled detection follow the run queue. */
  startWorker(): void {
    if (this.worker || this.closed) return;
    const { jobLockMs, stalledIntervalMs } = this.d.config().runtime;
    this.workerConn = bullConnection(this.d.redisUrl, this.d.log);
    this.worker = new Worker<UsageReportJob>(USAGE_REPORT_QUEUE, (j) => this.process(j), {
      connection: this.workerConn,
      concurrency: this.d.config().hooks.usageReportConcurrency,
      lockDuration: jobLockMs,
      stalledInterval: stalledIntervalMs,
      maxStalledCount: 3,
    });
    this.worker.on("error", (err) => this.d.log.error("usage report worker error", { err }));
    this.worker.on("failed", (j, err) => {
      if (!j) return;
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

  /** Stops the worker (in-flight handler calls are aborted and their jobs retried) and the queue. */
  async stop(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
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

  private getQueue(): Queue<UsageReportJob> {
    if (this.closed) throw new Error("usage report queue is closed");
    if (!this.queue) {
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
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    return {
      eventId: `${conversationId}/${seq}`,
      orgId: row.org_id,
      accountId: row.trigger_account_id ?? row.account_id,
      agentId: row.agent_id,
      conversationId,
      conversationKind: row.kind,
      runId: row.run_id ?? "",
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

  private async process(j: Job<UsageReportJob>): Promise<void> {
    const { conversationId, seq } = j.data;
    const payload = await this.payloadOf(conversationId, seq);
    if (payload === null) return; // conversation deleted meanwhile: nothing to report
    const enabled = await this.d.enabledPlugins(payload.orgId);
    const byPlugin = new Map<string, HookHandler<"usage.report">[]>();
    for (const h of this.d.hooks.handlers("usage.report")) {
      byPlugin.set(h.plugin, [...(byPlugin.get(h.plugin) ?? []), h.handler]);
    }
    // first attempt: every enabled plugin with a handler; later attempts: the recorded pending set
    const targets = (j.data.pending ?? [...byPlugin.keys()]).filter((p) => enabled.has(p));
    const frozen = deepFreeze(structuredClone(payload));
    const timeoutMs = this.d.config().hooks.timeoutMs;
    const failed: string[] = [];
    for (const plugin of targets) {
      const handlers = byPlugin.get(plugin);
      if (!handlers || handlers.length === 0) {
        failed.push(plugin);
        continue;
      }
      try {
        for (const h of handlers) await this.call(h, frozen, timeoutMs);
      } catch (err) {
        this.d.log.warn("usage.report handler failed", {
          plugin,
          eventId: payload.eventId,
          error: errMsg(err),
        });
        failed.push(plugin);
      }
    }
    if (failed.length > 0) {
      await j.updateData({ conversationId, seq, pending: failed });
      throw new Error(`usage.report failed for: ${failed.join(", ")}`);
    }
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
