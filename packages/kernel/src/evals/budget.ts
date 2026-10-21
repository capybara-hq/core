import type { ModelUsage } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelDb } from "../db/kernel-schema.js";
import { type CaseSnapshot, replayableCalls } from "./snapshot.js";

/**
 * 评测运行的 token 预算（C7）：`eval_runs.tokens_used` 在 PG 里原子累加，达到 `token_cap` 的同一条语句把
 * 状态置为 `capped`；worker 每次请求前查 {@link runActive}，不活跃就不再发新请求。在途请求可以越过上限，
 * 每个并发任务最多多一次请求（超出量 ≤ 在途任务数 × 一次请求）。
 */

/** 还在执行的运行状态。 */
export const ACTIVE_EVAL_STATUSES = ["queued", "running"] as const;

/** 一次请求计入预算的 token：用量四项之和（四项互不重叠，见 plugin-sdk `ModelUsage`）。 */
export const usageTokens = (u: ModelUsage): number =>
  u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/**
 * 累加用量：`UPDATE … RETURNING`，累加后 ≥ 上限且运行仍在执行 → 同一语句置 `capped`、记 `finished_at`。
 * 运行已不在（被删）时返回 `{ used: 0, capped: true }`，调用方同样停下。
 */
export async function consumeTokens(
  db: KernelDb,
  runId: string,
  tokens: number,
): Promise<{ used: number; capped: boolean }> {
  const n = Math.max(0, Math.trunc(tokens));
  const reaches = sql<boolean>`tokens_used + ${n} >= token_cap AND status IN ('queued', 'running')`;
  const r = await db
    .updateTable("eval_runs")
    .set({
      tokens_used: sql`tokens_used + ${n}`,
      status: sql`CASE WHEN ${reaches} THEN 'capped' ELSE status END`,
      finished_at: sql`CASE WHEN ${reaches} THEN now() ELSE finished_at END`,
    })
    .where("id", "=", runId)
    .returning(["tokens_used", "status"])
    .executeTakeFirst();
  if (!r) return { used: 0, capped: true };
  return { used: Number(r.tokens_used), capped: r.status === "capped" };
}

/** 运行仍在执行（queued / running）：取消、达到上限、已结束或已删除都为 false。 */
export async function runActive(db: KernelDb, runId: string): Promise<boolean> {
  const r = await db
    .selectFrom("eval_runs")
    .select("id")
    .where("id", "=", runId)
    .where("status", "in", [...ACTIVE_EVAL_STATUSES])
    .executeTakeFirst();
  return r !== undefined;
}

/** 一个用例要回放的调用与原运行的用量（估算与预建结果用）。 */
export interface CasePlan {
  /** step 模式：每个可回放调用一行；run 模式：整个用例一行（step / seq 为 null）。 */
  results: { step: number | null; modelCallSeq: number | null }[];
  /** 预计的模型请求数。 */
  modelRequests: number;
  /** 这些请求在原运行里的用量（逐项相加）。 */
  usage: ModelUsage;
}

const ZERO: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export const addUsage = (a: ModelUsage, b: ModelUsage): ModelUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

const asUsage = (p: unknown): ModelUsage => {
  const x = p as Partial<ModelUsage>;
  return {
    inputTokens: x.inputTokens ?? 0,
    outputTokens: x.outputTokens ?? 0,
    cacheReadTokens: x.cacheReadTokens ?? 0,
    cacheWriteTokens: x.cacheWriteTokens ?? 0,
  };
};

/**
 * 一个用例的回放计划：
 * - `step`：请求 = 可回放的调用（`replayableCalls`），用量 = 这些调用各自记录的 usage（该步该调用之后第一条）；
 * - `run`：请求 = 原运行的全部 `model_call`，用量 = 原运行的全部 usage。
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
    return { results: [{ step: null, modelCallSeq: null }], modelRequests: calls, usage };
  }
  const calls = replayableCalls(s);
  let usage = ZERO;
  for (const c of calls) {
    const u = own.find(
      (e) => e.type === "usage" && e.seq > c.seq && (e.payload as { step: number }).step === c.step,
    );
    if (u) usage = addUsage(usage, asUsage(u.payload));
  }
  return {
    results: calls.map((c) => ({ step: c.step, modelCallSeq: c.seq })),
    modelRequests: calls.length,
    usage,
  };
}
