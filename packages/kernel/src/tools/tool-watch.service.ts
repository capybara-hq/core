import { type Logger, parseToolKey, type ToolWatchContext } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { DelayedError, type Job } from "bullmq";
import { sql } from "kysely";
import { EffectiveConfigs } from "../extensions/effective-config.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { attachCallScope } from "./call-scope.js";
import { OrgToolSwitches } from "./org-tool-switches.js";
import { extensionCallContext, extensionCallGate } from "./pipeline.js";
import { QuestionsService } from "./questions.service.js";
import { ToolRegistry } from "./registry.js";
import {
  TOOL_WATCH_MAX_FAILURES,
  TOOL_WATCH_TIMINGS,
  type ToolWatchJobData,
  type ToolWatchTimings,
  toolWatchTimings,
} from "./tool-watch-queue.js";

/** What one poll decided ({@link ToolWatchService.decide}). */
export type ToolWatchDecision = "wake" | "pending" | "failure" | "done";

/**
 * The watched-wait poll (browser long waits spec §5.3): one `tool-watch` job per watched question
 * (`tool-watch-<questionId>`), re-delayed every 10 s (`TOOL_WATCH_INTERVAL_MS`) while the question
 * is pending. A poll reads the question, its run and conversation; passes the pipeline's own
 * pre-call gate ({@link extensionCallGate}, R17) and needs the tool's registered watcher; builds
 * the watcher's context as the pipeline builds a handler's ({@link extensionCallContext}) with a
 * call scope marked `watch` (its device requests never resume or start anything); and calls the
 * watcher, bounded by 5 s (`TOOL_WATCH_TIMEOUT_MS`). `settle`, a durable refusal (disabled in the
 * org, switched off, invalid config, no watcher) or {@link TOOL_WATCH_MAX_FAILURES} failures in a
 * row wake the question (`QuestionsService.wake`, conditional on pending under the row lock);
 * `pending` re-delays. An extension only not loaded on this replica is a failure, not a wake
 * (R22). No in-process state: the question row and the job are the whole truth.
 */
@Injectable()
export class ToolWatchService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(ToolRegistry) private readonly registry: Pick<ToolRegistry, "watcher">,
    @Inject(OrgToolSwitches) private readonly switches: Pick<OrgToolSwitches, "isToolOff">,
    @Inject(EffectiveConfigs) private readonly effective: Pick<EffectiveConfigs, "get">,
    @Inject(QuestionsService) private readonly questions: Pick<QuestionsService, "wake">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn">,
    /** Shorter poll timings (a kernel test seam). */
    @Optional() @Inject(TOOL_WATCH_TIMINGS) timings?: Partial<ToolWatchTimings>,
  ) {
    this.timings = toolWatchTimings(timings);
  }

  private readonly timings: ToolWatchTimings;

  private get db() {
    return this.kdb.db;
  }

  /**
   * One job run: decide, then wake, re-delay, count a watcher failure, or end. A kernel-side
   * error (PG or the wake's transaction, briefly unavailable) is not the watcher's: the poll is
   * re-delayed with its failure count unchanged and tried again next interval, so a blip never
   * ends a wait and never uses up the job's attempts (only a failing re-delay itself, Redis
   * gone, falls back to the queue's retries; the question's deadline still ends the wait).
   */
  async process(job: Job<ToolWatchJobData>, token: string | undefined): Promise<void> {
    let failures = job.data.failures;
    try {
      const decision = await this.decide(job.data);
      if (decision === "done") return;
      failures = decision === "failure" ? job.data.failures + 1 : 0;
      if (decision === "wake" || failures >= TOOL_WATCH_MAX_FAILURES) {
        await this.questions.wake(job.data.questionId);
        return;
      }
    } catch (err) {
      this.log.warn("a tool watch poll failed in the kernel; polling again", {
        questionId: job.data.questionId,
        error: err instanceof Error ? err.message : String(err),
      });
      failures = job.data.failures;
    }
    if (failures !== job.data.failures) await job.updateData({ ...job.data, failures });
    await job.moveToDelayed(Date.now() + this.timings.intervalMs, token);
    throw new DelayedError();
  }

  /** What one poll of the question's watcher says (no writes). */
  async decide(data: ToolWatchJobData): Promise<ToolWatchDecision> {
    // the question of the kernel-written job payload, in the job's org (runJob's scope)
    const row = await this.db
      .selectFrom("questions as q")
      .innerJoin("runs as r", "r.id", "q.run_id")
      .innerJoin("conversations as c", "c.id", "q.conversation_id")
      .select([
        "q.id",
        "q.org_id",
        "q.run_id",
        "q.call_id",
        "q.status",
        "q.spec",
        sql<boolean>`q.expires_at <= now()`.as("expired"),
        "r.trigger_account_id",
        "r.agent_version",
        "c.id as conversation_id",
        "c.account_id",
        "c.agent_id",
        "c.source",
        "c.kind",
      ])
      .where("q.id", "=", data.questionId)
      .where("q.org_id", "=", data.orgId)
      .executeTakeFirst();
    // the timeout job owns an expired question; a settled one needs nothing
    if (row === undefined || row.status !== "pending" || row.expired) return "done";
    const spec = row.spec as { toolKey?: unknown; state?: unknown; step?: unknown };
    const toolKey = typeof spec.toolKey === "string" ? spec.toolKey : "";
    const parsed = parseToolKey(toolKey);
    if (parsed?.kind !== "extension") return "wake";
    const source = { kind: "plugin" as const, plugin: parsed.plugin, name: parsed.tool };
    const gate = await extensionCallGate(
      { switches: this.switches, effective: this.effective },
      row.org_id,
      toolKey,
      source,
      { checkEnabled: (orgId, plugin) => isExtensionEnabled(this.db, orgId, plugin) },
    );
    if (!gate.ok) return gate.transient ? "failure" : "wake";
    const watcher = this.registry.watcher(source);
    if (watcher === undefined) return "wake";

    // fixed for the wait: read once at the ask (the role as it was then)
    const { role, rootConversationId, unattended } = data.facts;
    // the watcher's bound (it counts as a failure); the race ends a watcher that ignores it
    const signal = AbortSignal.timeout(this.timings.timeoutMs);
    const ctx: ToolWatchContext = {
      ...extensionCallContext({
        orgId: row.org_id,
        accountId: row.trigger_account_id,
        agentId: row.agent_id,
        conversationId: row.conversation_id,
        rootConversationId,
        runId: row.run_id,
        callId: row.call_id,
        source: row.source,
        ownerAccountId: row.account_id,
        role,
      }),
      config: gate.config,
      state: spec.state ?? null,
      signal,
    };
    attachCallScope(
      ctx,
      {
        runId: row.run_id,
        step: typeof spec.step === "number" ? spec.step : 0,
        rootConversationId,
        unattended,
        agentVersion: row.agent_version,
        conversationKind:
          row.kind === "eval" ? "eval" : row.kind === "subagent" ? "subagent" : "chat",
      },
      { watch: true },
    );
    try {
      const answer = await Promise.race([
        watcher(ctx),
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
      if (answer === "settle") return "wake";
      if (answer === "pending") return "pending";
      this.log.warn("a tool watcher answered neither settle nor pending", {
        toolKey,
        questionId: row.id,
      });
      return "failure";
    } catch (err) {
      this.log.warn("a tool watcher failed", {
        toolKey,
        questionId: row.id,
        failures: data.failures + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failure";
    }
  }
}
