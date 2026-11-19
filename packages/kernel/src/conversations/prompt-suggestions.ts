import {
  type ContentBlock,
  type HookScope,
  isModelError,
  type ModelRequest,
  type ModelUsage,
} from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import type { Job, Queue, Worker } from "bullmq";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { loadSnapshotMedia } from "../evals/reconstruct.js";
import { type CaseSnapshot, takeSnapshot, toEvents } from "../evals/snapshot.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { ExtensionHost } from "../extensions/host.js";
import { audit } from "../identity/audit.js";
import { IdentityModule } from "../identity/identity.module.js";
import { SettingsService } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgSettingsModule, OrgSettingsService } from "../orgs/settings.service.js";
import { resolveCompactionSettings } from "../runtime/compaction-settings.service.js";
import {
  type AuditEntry,
  fireObserve,
  type HookRunner,
  hookDeniedAudit,
  hookDeniedEvent,
  hookRequestOf,
} from "../runtime/hook-calls.js";
import { consumeModelStream } from "../runtime/model-call.js";
import { type BoundProvider, ProviderRegistry, ProvidersModule } from "../runtime/providers.js";
import { UsageReportJobs, UsageReportJobsModule } from "../runtime/usage-report-jobs.js";
import { AttachmentsModule } from "./attachments.module.js";
import { AttachmentsService } from "./attachments.service.js";
import { type AppendEvent, EventLog, EventLogModule } from "./event-log.js";
import type { ConversationEvent, EventPayload } from "./events.js";
import {
  buildSuggestionRequest,
  cleanSuggestion,
  lastModelCallOf,
  PROMPT_SUGGESTION_TIMEOUT_MS,
  suggestionEligible,
  suggestionStale,
} from "./prompt-suggestion-request.js";
import { PromptSuggestionStore } from "./prompt-suggestion-store.js";

/**
 * Prompt suggestions (spec 2026-11-19 §2, §3, §7, §8): after a completed web run the run worker
 * calls {@link PromptSuggestionQueue.maybeEnqueue} (a hint after the commit: a lost enqueue costs
 * one suggestion, so no outbox row). The worker-role job ({@link PromptSuggestionGenerator.run})
 * re-checks the run, rebuilds its last request through the eval zero-drift path, fires
 * `model.request` (policy fail closed, then observe) with `purpose: "suggestion"`, calls the run's
 * own model once (no retry, no fallback), fires `model.response`, logs a run-less `usage` event
 * owing its `usage.report`, and stores the cleaned text ({@link PromptSuggestionStore}) while the
 * run is still the conversation's newest exchange. No lock, no transaction around the call, no
 * process state beyond the stop signal. Nothing model-visible: no `model_call`, no DriftReason.
 */

/** The suggestion queue (no `:` in the name). */
export const PROMPT_SUGGESTION_QUEUE = "cap-kernel-suggestions";
/** One job per run (no `:`: run ids are UUIDs); a second enqueue of the same run is a no-op. */
export const promptSuggestionJobId = (runId: string): string => `suggest-${runId}`;
/** Worker concurrency per replica (the calls are short and mostly cached). */
export const PROMPT_SUGGESTION_CONCURRENCY = 4;
const JOB = "suggest";

/**
 * Test seam (`KernelSeams`): the side call's time limit in ms, asked at every call; default
 * {@link PROMPT_SUGGESTION_TIMEOUT_MS}.
 */
export const PROMPT_SUGGESTION_TIMEOUT = Symbol("PROMPT_SUGGESTION_TIMEOUT");

/**
 * Model error kinds where the vendor refused the request before processing it: nothing is billed,
 * so no estimated usage is logged.
 */
const UNBILLED_KINDS: ReadonlySet<string> = new Set([
  "rate_limited",
  "overloaded",
  "auth",
  "invalid_request",
  "context_overflow",
]);

/** The usage event's idempotency key: one suggestion usage per run. */
const usageIdemKey = (runId: string): string => `usage_suggestion:${runId}`;

/** Whether the run's suggestion usage event exists (its call was made: a rerun is a no-op). */
async function suggestionUsageExists(
  db: KernelSchemaDb,
  conversationId: string,
  runId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("conversation_events")
    .select(sql`1`.as("one"))
    .where("conversation_id", "=", conversationId)
    .where("idem_key", "=", usageIdemKey(runId))
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** The job's data. `finishedAt`: when the run finished (epoch ms), for the staleness guard. */
export interface PromptSuggestionJob {
  conversationId: string;
  runId: string;
  finishedAt: number;
}

type RunOutcome = EventPayload<"run_finished">["reason"];
type StreamOut = Awaited<ReturnType<typeof consumeModelStream>>;

const textOf = (content: readonly ContentBlock[]): string =>
  content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");

/** The failed call's error code; an abort of the call's own signal is its time limit. */
const errorCodeOf = (err: unknown, signal: AbortSignal): string =>
  isModelError(err) ? `model.${err.kind}` : signal.aborted ? "model.timeout" : "model.unknown";

/** The facts the job reads about the run (spec §2), or a skip reason. */
interface RunFacts {
  orgId: string;
  agentId: string;
  accountId: string;
  agentVersion: number;
  afterSeq: number;
}

/**
 * One suggestion job's work over the injected services, with its writes in transactions of their
 * own: the call's usage event (owing its delivery) and a policy denial's audit row.
 */
@Injectable()
export class PromptSuggestionGenerator {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "appendInReport" | "notify">,
    @Inject(ProviderRegistry) private readonly registry: Pick<ProviderRegistry, "resolve">,
    /** The call fires the plugin hooks (`model.request`, `model.response`). */
    @Inject(ExtensionHost) private readonly host: { readonly hooks?: HookRunner } | undefined,
    /** The call's `usage.report` delivery, owed with its usage event. */
    @Inject(UsageReportJobs) private readonly usage: Pick<UsageReportJobs, "oweEvents">,
    @Inject(OrgSettingsService)
    private readonly orgSettings: Pick<OrgSettingsService, "promptSuggestionsEnabled">,
    /** The platform's compaction settings (the org's reserve for the fit guard). */
    @Inject(SettingsService) private readonly settings: Pick<SettingsService, "get">,
    /** The run's media, as the run's steps load it. */
    @Inject(AttachmentsService)
    private readonly attachments: Pick<AttachmentsService, "mediaInfo" | "fetchMedia">,
    @Inject(PromptSuggestionStore)
    private readonly store: Pick<PromptSuggestionStore, "isFresh" | "put">,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "debug" | "warn">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Optional()
    @Inject(PROMPT_SUGGESTION_TIMEOUT)
    private readonly timeoutMs: () => number = () => PROMPT_SUGGESTION_TIMEOUT_MS,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * One suggestion for the run (spec §1–§4); `shutdown` aborts the call (the worker stopping).
   * Never throws: every skip and failure is logged and means no suggestion.
   */
  async run(
    conversationId: string,
    runId: string,
    finishedAt: number,
    shutdown: AbortSignal,
  ): Promise<void> {
    const skip = (reason: string) =>
      this.log.debug("prompt suggestion skipped", { conversationId, runId, reason });
    try {
      if (suggestionStale(finishedAt, Date.now())) return skip("stale");
      if (shutdown.aborted) return skip("shutdown");
      const facts = await this.runFacts(conversationId, runId);
      if (typeof facts === "string") return skip(facts);
      // a rerun job (a stalled job's retry, an enqueue after the job was removed): the call was
      // made and billed already
      if (await suggestionUsageExists(this.db, conversationId, runId)) return skip("done");
      if (!(await this.orgSettings.promptSuggestionsEnabled(facts.orgId))) return skip("off");
      if (!(await this.store.isFresh(conversationId, { runId, afterSeq: facts.afterSeq }))) {
        return skip("not_fresh");
      }

      let snapshot: CaseSnapshot;
      try {
        snapshot = await takeSnapshot(
          this.db,
          facts.orgId,
          conversationId,
          runId,
          this.config.get().evals.maxCaseBytes,
        );
      } catch (err) {
        if (err instanceof ApiError) return skip(err.code);
        throw err;
      }
      const last = lastModelCallOf(toEvents(snapshot), runId);
      if (last === undefined) return skip("no_model_call");
      const ref = { provider: last.payload.provider, model: last.payload.model };
      let provider: BoundProvider;
      let info: Awaited<ReturnType<ProviderRegistry["resolve"]>>["info"];
      try {
        ({ provider, info } = await this.registry.resolve(facts.orgId, ref));
      } catch {
        return skip("model_unavailable");
      }
      let media: Awaited<ReturnType<typeof loadSnapshotMedia>>;
      try {
        media = await loadSnapshotMedia(snapshot, last.seq, info, {
          info: (orgId, convId, ids) => this.attachments.mediaInfo(orgId, convId, ids),
          fetch: (orgId, convId, ids, caps) =>
            this.attachments.fetchMedia(orgId, convId, ids, caps),
        });
      } catch {
        return skip("media_unavailable");
      }
      const { reserveTokens } = await resolveCompactionSettings(
        this.settings,
        this.db,
        facts.orgId,
      );
      const built = buildSuggestionRequest({
        snapshot,
        model: info,
        mediaInfo: media.mediaInfo,
        media: media.media,
        reserveTokens,
      });
      if ("skip" in built) return skip(built.skip);
      const { request, estimate, finalText } = built;

      const scope: HookScope = {
        orgId: facts.orgId,
        accountId: facts.accountId,
        agentId: facts.agentId,
        agentVersion: facts.agentVersion,
        conversationId,
        runId,
      };
      const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs()), shutdown]);
      if (!(await this.allowed(scope, ref, request, signal))) return;
      if (signal.aborted) return skip("shutdown");

      const sentAt = Date.now();
      let streamedChars = 0;
      let out: StreamOut;
      try {
        out = await consumeModelStream(
          provider,
          request,
          info.streamIdleTimeoutMs ?? this.config.get().runtime.streamIdleMs,
          signal,
          (ev) => {
            streamedChars += ev.text.length;
          },
        );
      } catch (err) {
        if (shutdown.aborted) {
          // cut by the replica stopping: no model.response (spec §7), the job is dropped
          skip("aborted");
        } else {
          // the observe hooks run on the lifecycle signal: the call's own signal is aborted after
          // its time limit and would skip them
          this.observe(scope, ref, sentAt, null, err, signal, shutdown);
          this.log.warn("prompt suggestion call failed", {
            conversationId,
            runId,
            provider: ref.provider,
            model: ref.model,
            errorCode: errorCodeOf(err, signal),
          });
        }
        // a vendor refusal before processing bills nothing; any other sent call (a shutdown abort
        // included) is billed: log its estimated input plus the output streamed so far
        if (!isModelError(err) || !UNBILLED_KINDS.has(err.kind)) {
          await this.logUsage(conversationId, runId, {
            ...ref,
            usage: {
              inputTokens: estimate,
              outputTokens: Math.ceil(streamedChars / 4),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          });
        }
        return;
      }
      this.observe(scope, ref, sentAt, out, null, signal, shutdown);
      await this.logUsage(conversationId, runId, { ...ref, usage: out.usage });

      const outcome = await this.result(conversationId, runId, facts.afterSeq, out, finalText);
      this.log.debug("prompt suggestion call", {
        conversationId,
        runId,
        provider: ref.provider,
        model: ref.model,
        inputTokens: out.usage.inputTokens,
        cacheReadTokens: out.usage.cacheReadTokens,
        cacheWriteTokens: out.usage.cacheWriteTokens,
        outputTokens: out.usage.outputTokens,
        outcome,
      });
    } catch (err) {
      this.log.warn("prompt suggestion job failed", { conversationId, runId, err });
    }
  }

  /**
   * The run's facts by spec §2 (outcome, conversation kind and source, trigger) and its hook scope,
   * or why it gets no suggestion.
   */
  private async runFacts(conversationId: string, runId: string): Promise<RunFacts | string> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["org_id", "agent_id", "kind", "source"])
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (!conv) return "no_conversation";
    const rows = await this.db
      .selectFrom("conversation_events")
      .select(["seq", "type", "payload"])
      .where("conversation_id", "=", conversationId)
      .where("run_id", "=", runId)
      .where("type", "in", ["run_started", "run_finished"])
      .orderBy("seq")
      .execute();
    const started = rows.find((r) => r.type === "run_started");
    const finished = rows.find((r) => r.type === "run_finished");
    if (!started || !finished) return "not_finished";
    const s = started.payload as EventPayload<"run_started">;
    const f = finished.payload as EventPayload<"run_finished">;
    const eligible = suggestionEligible({
      outcome: f.reason,
      kind: conv.kind,
      source: conv.source,
      trigger: s.trigger,
    });
    if (!eligible) return "not_eligible";
    return {
      orgId: conv.org_id,
      agentId: conv.agent_id,
      accountId: s.triggerAccountId,
      agentVersion: s.agentVersion,
      afterSeq: Number(finished.seq),
    };
  }

  /**
   * `model.request` (`purpose: "suggestion"`, the run's id, step 0, attempt 1): policy hooks first,
   * failing closed (a policy extension not loaded on this replica denies), then observe. A denial
   * writes the `hook.denied` audit row (`detail.purpose: "suggestion"`) and no `hook_denied`
   * event (the call is not a step of the run).
   */
  private async allowed(
    scope: HookScope,
    ref: { provider: string; model: string },
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    const hooks = this.host?.hooks;
    if (!hooks?.has("model.request")) return true;
    const verdict = await hooks.run(
      "model.request",
      {
        ...scope,
        purpose: "suggestion",
        step: 0,
        attempt: 1,
        provider: ref.provider,
        model: ref.model,
        request: hookRequestOf(request, this.log),
      },
      signal,
    );
    if (verdict.allowed) return true;
    const site = {
      orgId: scope.orgId,
      conversationId: scope.conversationId,
      runId: scope.runId,
      accountId: scope.accountId,
      agentId: scope.agentId,
      idemKey: "",
    };
    const entry = hookDeniedAudit(
      site,
      hookDeniedEvent(site, "model.request", verdict, { step: 0, attempt: 1 }).payload,
      verdict,
    );
    entry.detail = { ...entry.detail, purpose: "suggestion" };
    await this.auditDenied(entry);
    this.log.warn("prompt suggestion blocked by a policy hook", {
      conversationId: scope.conversationId,
      runId: scope.runId,
      plugin: verdict.plugin,
      cause: verdict.cause,
    });
    return false;
  }

  /**
   * `model.response` for a sent call (observe only, not awaited). The hooks run on `lifecycle`
   * (the worker stopping), never on the call's own signal: a timed-out call still reports.
   */
  private observe(
    scope: HookScope,
    ref: { provider: string; model: string },
    sentAt: number,
    out: StreamOut | null,
    err: unknown,
    callSignal: AbortSignal,
    lifecycle: AbortSignal,
  ): void {
    const hooks = this.host?.hooks;
    if (!hooks) return;
    fireObserve(
      hooks,
      "model.response",
      {
        ...scope,
        purpose: "suggestion",
        step: 0,
        attempt: 1,
        provider: ref.provider,
        model: ref.model,
        outcome: out ? "ok" : "failed",
        content: out?.content ?? [],
        stopReason: out?.stopReason ?? null,
        usage: out?.usage ?? null,
        latencyMs: Date.now() - sentAt,
        ...(out === null && { errorCode: errorCodeOf(err, callSignal) }),
      },
      lifecycle,
      this.log,
    );
  }

  /**
   * The reply's outcome (spec §1.4, §1.7, §4): a tool call or a stop reason other than `end_turn`
   * is discarded, as is a reply that cleans to nothing; the text is stored only while the run is
   * still fresh. A failed write is logged (the usage stands).
   */
  private async result(
    conversationId: string,
    runId: string,
    afterSeq: number,
    out: StreamOut,
    finalText: string,
  ): Promise<string> {
    if (out.content.some((b) => b.type === "tool_call")) return "tool_call";
    if (out.stopReason !== "end_turn") return `stop_${out.stopReason}`;
    const text = cleanSuggestion(textOf(out.content), finalText);
    if (text === null) return "none";
    if (!(await this.store.isFresh(conversationId, { runId, afterSeq }))) return "not_fresh";
    try {
      await this.store.put(conversationId, { runId, afterSeq, text, createdAt: Date.now() });
    } catch (err) {
      this.log.warn("prompt suggestion write failed", { conversationId, runId, err });
      return "write_failed";
    }
    return "stored";
  }

  private async logUsage(
    conversationId: string,
    runId: string,
    u: { provider: string; model: string; usage: ModelUsage },
  ): Promise<void> {
    const ev = await this.writeUsage(conversationId, runId, u);
    if (ev) await this.eventLog.notify(conversationId, ev.seq);
  }

  /**
   * Appends the call's `usage` event (`purpose: "suggestion"`, step 0, no run, one per run) and
   * owes its `usage.report` delivery, in one transaction of its own.
   */
  @Transactional({ propagation: "requires_new" })
  async writeUsage(
    conversationId: string,
    runId: string,
    u: { provider: string; model: string; usage: ModelUsage },
  ): Promise<ConversationEvent | undefined> {
    const event: AppendEvent = {
      type: "usage",
      idemKey: usageIdemKey(runId),
      payload: {
        step: 0,
        provider: u.provider,
        model: u.model,
        inputTokens: u.usage.inputTokens,
        outputTokens: u.usage.outputTokens,
        cacheReadTokens: u.usage.cacheReadTokens,
        cacheWriteTokens: u.usage.cacheWriteTokens,
        purpose: "suggestion",
      },
    };
    const { events, fresh } = await this.eventLog.appendInReport(conversationId, [event]);
    // only when this call wrote it (a replayed job's hit owes nothing new)
    if (fresh[0]) await this.usage.oweEvents(conversationId, events);
    return fresh[0] ? events[0] : undefined;
  }

  /** The `hook.denied` audit row of a denied suggestion call. */
  @Transactional({ propagation: "requires_new" })
  async auditDenied(entry: AuditEntry): Promise<void> {
    await audit(this.db, entry);
  }
}

/**
 * The suggestion queue: `maybeEnqueue` on any role (the run worker after a completed run), consumed
 * on the `worker` role by its `@Processor`. One attempt per job (no BullMQ retries); the stop
 * aborts the call in flight and the job is dropped.
 */
@Injectable()
export class PromptSuggestionQueue {
  private worker: Worker<PromptSuggestionJob> | undefined;
  private closed = false;
  /** Lifecycle only: aborts the calls in flight when this process stops. */
  private readonly stopping = new AbortController();

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(getQueueToken(PROMPT_SUGGESTION_QUEUE))
    private readonly queue: Queue<PromptSuggestionJob>,
    @Inject(PromptSuggestionGenerator)
    private readonly generator: Pick<PromptSuggestionGenerator, "run">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn" | "error">,
  ) {
    queue.on("error", (err) => this.log.error("prompt suggestion queue error", { err }));
  }

  /**
   * Enqueues the run's suggestion job when the outcome is `completed` or `max_steps` (never
   * `max_duration` or `budget`), the conversation is a web chat and the run has no suggestion
   * usage yet. A hint after the commit: never throws (logs instead).
   */
  async maybeEnqueue(conversationId: string, runId: string, kind: RunOutcome): Promise<void> {
    if (this.closed) return;
    if (kind !== "completed" && kind !== "max_steps") return;
    try {
      const due = await this.kdb.db
        .selectFrom("conversations as c")
        .select("c.id")
        .where("c.id", "=", conversationId)
        .where("c.kind", "=", "chat")
        .where("c.source", "=", "web")
        .executeTakeFirst();
      if (!due || (await suggestionUsageExists(this.kdb.db, conversationId, runId))) return;
      await this.queue.add(
        JOB,
        { conversationId, runId, finishedAt: Date.now() },
        {
          jobId: promptSuggestionJobId(runId),
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (err) {
      this.log.warn("cannot enqueue prompt suggestion", { conversationId, runId, err });
    }
  }

  /** Starts consuming (worker role only): `worker` is the `@Processor` worker of the queue. */
  startWorker(worker: Worker<PromptSuggestionJob>): void {
    if (this.worker || this.closed) return;
    this.worker = worker;
    void worker.run().catch((err) => this.log.error("prompt suggestion worker error", { err }));
  }

  /** The worker's `error` event. */
  onError(err: Error): void {
    this.log.error("prompt suggestion worker error", { err });
  }

  /** One suggestion job (the `@Processor` calls it). */
  async process(j: Job<PromptSuggestionJob>): Promise<void> {
    await this.generator.run(
      j.data.conversationId,
      j.data.runId,
      j.data.finishedAt,
      this.stopping.signal,
    );
  }

  /** Stops: no more enqueues, the call in flight is aborted (its job dropped), the worker closes. */
  async stop(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    const w = this.worker;
    this.worker = undefined;
    await w?.close().catch(() => {});
  }
}

/** The suggestion queue's registration (re-exported: the admin health reads its counts). */
const PROMPT_SUGGESTION_QUEUE_MODULE = QueueModule.registerQueue(PROMPT_SUGGESTION_QUEUE);

/** Prompt suggestions: the store, the queue and the job (consumed on the worker role). */
@Module({
  imports: [
    EventLogModule,
    ProvidersModule,
    ExtensionsModule,
    UsageReportJobsModule,
    OrgSettingsModule,
    IdentityModule,
    AttachmentsModule,
    PROMPT_SUGGESTION_QUEUE_MODULE,
  ],
  providers: [PromptSuggestionStore, PromptSuggestionGenerator, PromptSuggestionQueue],
  exports: [PromptSuggestionStore, PromptSuggestionQueue, PROMPT_SUGGESTION_QUEUE_MODULE],
})
export class PromptSuggestionsModule {}
