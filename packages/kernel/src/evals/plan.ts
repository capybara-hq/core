import type { ContentBlock, ModelUsage } from "@capybara-hq/plugin-sdk";
import type { ModelRef } from "../agents/definition.js";
import { estimateTokens } from "../runtime/context/tokens.js";
import { addUsage } from "./budget.js";
import { replyParts } from "./diff.js";
import { type CaseSnapshot, replayableCalls } from "./snapshot.js";

/**
 * A case's replay plan (D5 estimate, pre-built results): computed from the snapshot when the case is
 * written and stored in `eval_cases.plan_step` / `plan_run`; estimates and starts read only those
 * columns, never the snapshot.
 */

/** The calls a case replays and the original run's usage (for estimates and pre-built results). */
export interface CasePlan {
  /** Step mode: one row per replayable call; run mode: one row for the case (step / seq null). */
  results: { step: number | null; modelCallSeq: number | null }[];
  /** The expected number of model requests. */
  modelRequests: number;
  /** Those requests' usage in the original run (summed per field). */
  usage: ModelUsage;
  /**
   * The judge's context estimate: each result's "user request" tokens plus both replies (the
   * baseline's output tokens × 2; the candidate is estimated at the same amount). The judge's system
   * prompt, rubric and output cap are added at run time from the settings (`runs.service.ts`).
   */
  judgeContextTokens: number;
  /**
   * The model a person switched the case's run to (UI refresh B), absent when not switched: a
   * candidate agent version replays on it (`resolveCandidate`), so planning prices that model.
   */
  switchedModel?: ModelRef;
}

/** A plan as stored in `eval_cases.plan_step` / `plan_run` (the same shape as {@link CasePlan}). */
export type StoredCasePlan = CasePlan;

const ZERO: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const asUsage = (p: unknown): ModelUsage => {
  const x = p as Partial<ModelUsage>;
  return {
    inputTokens: x.inputTokens ?? 0,
    outputTokens: x.outputTokens ?? 0,
    cacheReadTokens: x.cacheReadTokens ?? 0,
    cacheWriteTokens: x.cacheWriteTokens ?? 0,
  };
};

/** The token estimate of a text (the same estimator as the runtime). */
export const textTokens = (text: string): number =>
  estimateTokens([], [{ text, cache: false }], []);

/** The newest user message before `beforeSeq` in the snapshot (the "user request" the judge sees). */
export function userRequestOf(s: CaseSnapshot, beforeSeq: number): string {
  const msg = s.events.findLast((e) => e.type === "user_message" && e.seq < beforeSeq);
  const content = (msg?.payload as { content?: ContentBlock[] } | undefined)?.content ?? [];
  return replyParts(content).text;
}

/**
 * Whether the case's run is a manual compact run (`run_started.trigger: "compact"`, context
 * compaction spec §4.7): it ran no model step (its boundary message was consumed by an earlier
 * run), so there is nothing to replay and planning it as an ordinary run would dispatch a step the
 * original never made.
 */
function compactRun(s: CaseSnapshot): boolean {
  return s.events.some(
    (e) =>
      e.runId === s.runId &&
      e.type === "run_started" &&
      (e.payload as { trigger?: string }).trigger === "compact",
  );
}

/** A plan with nothing to replay (no result rows, no requests, no usage). */
const NO_PLAN: CasePlan = {
  results: [],
  modelRequests: 0,
  usage: { ...ZERO },
  judgeContextTokens: 0,
};

/**
 * A case's replay plan:
 * - `step`: requests = the replayable calls (`replayableCalls`), usage = each call's recorded usage
 *   (the first one after that call, same step);
 * - `run`: requests = every `model_call` of the original run, usage = every usage of the run.
 * Computed when the case is written and stored in `plan_step` / `plan_run` ({@link casePlans}), so
 * estimates and starts do not read the snapshot.
 * A compact run has no plan in either mode ({@link compactRun}): estimates and starts skip it.
 */
export function casePlan(s: CaseSnapshot, mode: "step" | "run"): CasePlan {
  if (compactRun(s)) return { ...NO_PLAN, results: [], usage: { ...ZERO } };
  const own = s.events.filter((e) => e.runId === s.runId);
  if (mode === "run") {
    let usage = ZERO;
    let calls = 0;
    for (const e of own) {
      if (e.type === "model_call") calls++;
      else if (e.type === "usage") usage = addUsage(usage, asUsage(e.payload));
    }
    const start = own.find((e) => e.type === "run_started");
    const request = userRequestOf(s, start?.seq ?? Number.POSITIVE_INFINITY);
    return {
      results: [{ step: null, modelCallSeq: null }],
      modelRequests: calls,
      usage,
      judgeContextTokens: textTokens(request) + 2 * usage.outputTokens,
    };
  }
  const calls = replayableCalls(s);
  let usage = ZERO;
  let judgeContextTokens = 0;
  for (const c of calls) {
    const u = own.find(
      (e) =>
        e.type === "usage" &&
        e.seq > c.seq &&
        (e.payload as { step: number; purpose?: string }).step === c.step &&
        (e.payload as { purpose?: string }).purpose === undefined,
    );
    const callUsage = u ? asUsage(u.payload) : ZERO;
    usage = addUsage(usage, callUsage);
    judgeContextTokens += textTokens(userRequestOf(s, c.seq)) + 2 * callUsage.outputTokens;
  }
  return {
    results: calls.map((c) => ({ step: c.step, modelCallSeq: c.seq })),
    modelRequests: calls.length,
    usage,
    judgeContextTokens,
  };
}

/** 两种模式的计划（写入用例时调用）。 */
export const casePlans = (s: CaseSnapshot): { step: CasePlan; run: CasePlan } => ({
  step: casePlan(s, "step"),
  run: casePlan(s, "run"),
});
