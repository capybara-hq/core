import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import { trustedCache } from "./context/cache-ttl.js";
import { IDLE_MIN_CACHE_TTL, idleMinTokens } from "./context/idle-compaction-rules.js";
import { ProviderRegistry } from "./providers.js";

/** A return to a conversation is logged when the gap since its previous run ended exceeds this. */
export const IDLE_RETURN_GAP_MS = IDLE_MIN_CACHE_TTL * 1000;

export interface IdleReturnInput {
  /** When this run started, epoch ms. */
  startedAt: number;
  /** The previous run's `finished_at`, epoch ms. */
  previousFinishedAt: number;
  /** The previous run's last step call; null when it had none. */
  lastCall: {
    window: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    /** The call's recorded `cacheTtl`. */
    recordedTtl: number | undefined;
    /** The model's declared default lifetime. */
    defaultTtl: number | undefined;
  } | null;
  /** A `compaction_summary` of an idle compact run was written after `previousFinishedAt`. */
  idleSummary: boolean;
  settings: Parameters<typeof idleMinTokens>[1];
}

export interface IdleReturnFacts {
  gapMs: number;
  contextTokens: number;
  threshold: number;
  /** The previous run's last call's cache lifetime in seconds; null when none is known. */
  ttl: number | null;
  idleSummary: boolean;
}

/**
 * The facts of an `idle_return` log line (idle compaction spec S11), or null when the return does
 * not qualify: a gap of at most 30 minutes, no step call, or a context below the size threshold.
 * Cache lifetimes shorter than 30 minutes are included on purpose: they show the opportunities the
 * 30-minute rule leaves out.
 */
export function idleReturnFacts(i: IdleReturnInput): IdleReturnFacts | null {
  const gapMs = i.startedAt - i.previousFinishedAt;
  if (gapMs <= IDLE_RETURN_GAP_MS || i.lastCall === null) return null;
  const c = i.lastCall;
  const contextTokens = c.input + c.cacheRead + c.cacheWrite + c.output;
  const threshold = idleMinTokens(c.window, i.settings);
  if (contextTokens < threshold) return null;
  return {
    gapMs,
    contextTokens,
    threshold,
    ttl: c.recordedTtl ?? c.defaultTtl ?? null,
    idleSummary: i.idleSummary,
  };
}

/**
 * Logs one `info` line (`idle_return`, context=IdleCompaction) when a chat run starts on a
 * conversation that sat idle past the cache lifetimes idle compaction aims at, so the first weeks
 * of production show how often people return and what the compaction would have saved (spec §10).
 * Best effort: never throws.
 */
@Injectable()
export class IdleReturn {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(CompactionSettingsService)
    private readonly compaction: Pick<CompactionSettingsService, "resolve">,
    @Inject(ProviderRegistry) private readonly models: Pick<ProviderRegistry, "resolve">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "debug">,
  ) {}

  /** Outside any transaction (the model registry may list models over the network). */
  async record(
    conv: { id: string; org_id: string },
    runId: string,
    now = Date.now(),
  ): Promise<void> {
    try {
      await this.recordOrThrow(conv, runId, now);
    } catch (err) {
      this.log.debug("idle return not logged", {
        context: "IdleCompaction",
        conversationId: conv.id,
        runId,
        err,
      });
    }
  }

  private async recordOrThrow(
    conv: { id: string; org_id: string },
    runId: string,
    now: number,
  ): Promise<void> {
    const t = this.kdb.db;
    const prev = await t
      .selectFrom("runs")
      .select(["id", "finished_at"])
      .where("conversation_id", "=", conv.id)
      .where("compact", "=", false)
      .where("id", "!=", runId)
      .where("finished_at", "is not", null)
      .orderBy("finished_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (prev?.finished_at == null) return;
    const finishedAt = prev.finished_at.getTime();
    if (now - finishedAt <= IDLE_RETURN_GAP_MS) return;

    // the previous run's last step usage (a side call's usage carries a `purpose`)
    const usageRow = await t
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", conv.id)
      .where("run_id", "=", prev.id)
      .where("type", "=", "usage")
      .where(sql<boolean>`payload->>'purpose' IS NULL`)
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    type Usage = {
      step: number;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
    const usage = usageRow?.payload as Usage | undefined;
    let lastCall: IdleReturnInput["lastCall"] = null;
    if (usage !== undefined) {
      const call = await t
        .selectFrom("conversation_events")
        .select("payload")
        .where("conversation_id", "=", conv.id)
        .where("run_id", "=", prev.id)
        .where("type", "=", "model_call")
        .where(sql<number>`(payload->>'step')::int`, "=", usage.step)
        .orderBy("seq", "desc")
        .limit(1)
        .executeTakeFirst();
      const { info } = await this.models.resolve(conv.org_id, {
        provider: usage.provider,
        model: usage.model,
      });
      lastCall = {
        window: info.contextWindow,
        input: usage.inputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
        output: usage.outputTokens,
        recordedTtl: (call?.payload as { request?: { cacheTtl?: number } } | undefined)?.request
          ?.cacheTtl,
        defaultTtl: trustedCache(info.cache)?.defaultTtl,
      };
    }
    const settings = await this.compaction.resolve(conv.org_id);
    const facts = idleReturnFacts({
      startedAt: now,
      previousFinishedAt: finishedAt,
      lastCall,
      idleSummary: false,
      settings,
    });
    if (facts === null) return;

    const summary = await t
      .selectFrom("conversation_events as e")
      .innerJoin("runs as r", "r.id", "e.run_id")
      .select("e.seq")
      .where("e.conversation_id", "=", conv.id)
      .where("e.type", "=", "compaction_summary")
      .where("e.created_at", ">", prev.finished_at)
      .where("r.compact_origin", "=", "idle")
      .limit(1)
      .executeTakeFirst();
    this.log.info("idle_return", {
      context: "IdleCompaction",
      orgId: conv.org_id,
      conversationId: conv.id,
      runId,
      gapMs: facts.gapMs,
      contextTokens: facts.contextTokens,
      threshold: facts.threshold,
      ttl: facts.ttl,
      idleSummary: summary !== undefined,
    });
  }
}
