import type { ContentBlock, ModelUsage } from "@capybara-hq/plugin-sdk";
import type { ModelRef } from "../agents/definition.js";
import { estimateTokens } from "../runtime/context/tokens.js";
import { addUsage } from "./budget.js";
import { replyParts } from "./diff.js";
import { type CaseSnapshot, replayableCalls } from "./snapshot.js";

/**
 * 用例的回放计划（D5 估算、预建结果）：写入用例时由快照算好存进 `eval_cases.plan_step` / `plan_run`，
 * 估算与启动只读这些列，不读快照。
 */

/** 一个用例要回放的调用与原运行的用量（估算与预建结果用）。 */
export interface CasePlan {
  /** step 模式：每个可回放调用一行；run 模式：整个用例一行（step / seq 为 null）。 */
  results: { step: number | null; modelCallSeq: number | null }[];
  /** 预计的模型请求数。 */
  modelRequests: number;
  /** 这些请求在原运行里的用量（逐项相加）。 */
  usage: ModelUsage;
  /**
   * 评委的上下文估算：各条结果的「用户请求」token + 两边回复（基线输出 token × 2，候选按与基线同量估算）。
   * 评委的系统提示词、评分标准与输出上限按运行时的设置另加（见 `runs.service.ts`）。
   */
  judgeContextTokens: number;
  /**
   * The model a person switched the case's run to (UI refresh B), absent when not switched: a
   * candidate agent version replays on it (`resolveCandidate`), so planning prices that model.
   */
  switchedModel?: ModelRef;
}

/** 存在 `eval_cases.plan_step` / `plan_run` 的计划（与 {@link CasePlan} 同形）。 */
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

/** 一段文本的 token 估算（与运行时同一个估算器）。 */
export const textTokens = (text: string): number =>
  estimateTokens([], [{ text, cache: false }], []);

/** 快照里 `beforeSeq` 之前最近一条用户消息的文本（评委看的「用户请求」）。 */
export function userRequestOf(s: CaseSnapshot, beforeSeq: number): string {
  const msg = s.events.findLast((e) => e.type === "user_message" && e.seq < beforeSeq);
  const content = (msg?.payload as { content?: ContentBlock[] } | undefined)?.content ?? [];
  return replyParts(content).text;
}

/**
 * 一个用例的回放计划：
 * - `step`：请求 = 可回放的调用（`replayableCalls`），用量 = 这些调用各自记录的 usage（该步该调用之后第一条）；
 * - `run`：请求 = 原运行的全部 `model_call`，用量 = 原运行的全部 usage。
 * 写入用例时算好存进 `plan_step` / `plan_run`（{@link casePlans}），估算与启动不再读快照。
 */
export function casePlan(s: CaseSnapshot, mode: "step" | "run"): CasePlan {
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
