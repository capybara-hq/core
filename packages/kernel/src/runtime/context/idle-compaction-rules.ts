import type { ConversationEvent } from "../../conversations/events.js";
import type { CompactionSettings } from "../../identity/settings.js";
import { CACHE_EXPIRY_MARGIN_MS, type CacheExpiry } from "./cache-expiry.js";

/** Idle compaction only beats the expiry of a cache that lives at least this long, in seconds. */
export const IDLE_MIN_CACHE_TTL = 1800;
/** The next request must have grown at least this much over the summarized part, in tokens. */
export const IDLE_MIN_GROWTH_TOKENS = 20_000;

/** `run_started.trigger` (the field is optional: absent reads as a person's message). */
export type RunStartedTrigger = NonNullable<
  Extract<ConversationEvent, { type: "run_started" }>["payload"]["trigger"]
>;

/** `max(idleMinTokensFloor, idleMinWindowRatio × window)` (idle compaction spec §4.1). */
export function idleMinTokens(
  window: number,
  s: Pick<CompactionSettings, "idleMinTokensFloor" | "idleMinWindowRatio">,
): number {
  return Math.max(s.idleMinTokensFloor, Math.round(s.idleMinWindowRatio * window));
}

/**
 * An event that does not make an armed idle job stale (S1): a side-call `usage` event written
 * without a run (the title and prompt-suggestion jobs append them after a run ended).
 */
export function isIdleNeutralEvent(e: Pick<ConversationEvent, "type" | "runId">): boolean {
  return e.type === "usage" && e.runId === null;
}

export type IdleArmSkip =
  | "kind"
  | "trigger"
  | "automation"
  | "outcome"
  | "disabled"
  | "personal_off"
  | "no_cache"
  | "short_ttl"
  | "small"
  | "quality_gate"
  | "fit_plan"
  | "unsettled";

export interface IdleArmFacts {
  conversationKind: "chat" | "subagent" | "eval";
  /** `run_started.trigger`. */
  trigger: RunStartedTrigger | undefined;
  /** `runs.automation_run_id` (S5). */
  automationRunId: string | null;
  outcome: "completed" | "max_steps" | "max_duration" | "budget" | "max_output";
  /** Effective for the org. */
  settings: CompactionSettings;
  /** `accounts.idle_compaction = 'off'` of the owner. */
  personalOff: boolean;
  /** `deriveCacheExpiry` over the run's calls (S6). */
  expiry: CacheExpiry | null;
  lastCall: {
    provider: string;
    model: string;
    window: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  } | null;
  /** `inContextSummaryAllowed(provider, model)` (S7). */
  inContextAllowed: boolean;
  /**
   * The last step call's request recorded a fit plan: its prefix is not the plain history, so an
   * in-context summary cannot reuse it (the fire-time build skips it as `fit_plan`, S7).
   */
  fitPlan: boolean;
  /** No unanswered tool results after the last reply at the run's end (S7). */
  settled: boolean;
}

const ARMING_TRIGGERS: ReadonlySet<RunStartedTrigger | undefined> = new Set([
  undefined,
  "message",
  "background_task",
  "subagent",
]);

/** Whether a finished run owes an idle compaction job, and when it should fire. */
export function idleArmDecision(
  f: IdleArmFacts,
):
  | { arm: true; runAt: number; expiresAt: number; cacheCallSeq: number }
  | { arm: false; reason: IdleArmSkip } {
  if (f.conversationKind !== "chat") return { arm: false, reason: "kind" };
  if (!ARMING_TRIGGERS.has(f.trigger)) return { arm: false, reason: "trigger" };
  if (f.automationRunId !== null) return { arm: false, reason: "automation" };
  if (f.outcome === "budget") return { arm: false, reason: "outcome" };
  if (!(f.settings.enabled && f.settings.idleEnabled)) return { arm: false, reason: "disabled" };
  if (f.personalOff) return { arm: false, reason: "personal_off" };
  if (f.expiry === null || f.lastCall === null) return { arm: false, reason: "no_cache" };
  if (f.expiry.ttl < IDLE_MIN_CACHE_TTL) return { arm: false, reason: "short_ttl" };
  const c = f.lastCall;
  if (c.input + c.cacheRead + c.cacheWrite + c.output < idleMinTokens(c.window, f.settings)) {
    return { arm: false, reason: "small" };
  }
  if (!f.inContextAllowed) return { arm: false, reason: "quality_gate" };
  if (f.fitPlan) return { arm: false, reason: "fit_plan" };
  if (!f.settled) return { arm: false, reason: "unsettled" };
  return {
    arm: true,
    runAt: f.expiry.fireAt,
    expiresAt: f.expiry.expiresAt,
    cacheCallSeq: f.expiry.callSeq,
  };
}

export type IdleFireOutcome =
  | "gone"
  | "obsolete"
  | "busy"
  | "disabled"
  | "expired"
  | "backoff"
  | "no_model"
  | "small"
  | "no_prefix";

export interface IdleFireFacts {
  /** Org, conversation (chat) and agent are not deleted. */
  live: boolean;
  /** An event after `armedSeq` that `isIdleNeutralEvent` rejects (S1). */
  stale: boolean;
  /** An active run, an unconsumed message, or a queue head. */
  busy: boolean;
  /** Effective `enabled && idleEnabled && !personalOff`, read live. */
  enabled: boolean;
  now: number;
  expiresAt: number;
  /** The latest compaction record after the latest summary is `compaction_failed`. */
  backoff: boolean;
  /** The effective definition's model resolves, is enabled and equals the armed call's. */
  sameModel: boolean;
  probe: { estimate: number; window: number; growth: number; planned: boolean } | null;
  /** The probe's in-context build applied (no skip). */
  inContext: boolean;
  settings: CompactionSettings;
}

/** The fire-time checks of idle compaction spec §4.3, in order; the first failure names the outcome. */
export function idleFireDecision(
  f: IdleFireFacts,
): { fire: true } | { fire: false; outcome: IdleFireOutcome } {
  if (!f.live) return { fire: false, outcome: "gone" };
  if (f.stale) return { fire: false, outcome: "obsolete" };
  if (f.busy) return { fire: false, outcome: "busy" };
  if (!f.enabled) return { fire: false, outcome: "disabled" };
  if (f.now >= f.expiresAt - CACHE_EXPIRY_MARGIN_MS) return { fire: false, outcome: "expired" };
  if (f.backoff) return { fire: false, outcome: "backoff" };
  if (!f.sameModel) return { fire: false, outcome: "no_model" };
  const p = f.probe;
  if (
    p === null ||
    !p.planned ||
    p.estimate < idleMinTokens(p.window, f.settings) ||
    p.growth < IDLE_MIN_GROWTH_TOKENS
  ) {
    return { fire: false, outcome: "small" };
  }
  if (!f.inContext) return { fire: false, outcome: "no_prefix" };
  return { fire: true };
}
