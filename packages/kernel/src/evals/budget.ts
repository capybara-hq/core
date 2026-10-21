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

/** 连续出错熔断时运行记的原因（英文；界面按 code 走 i18n）。 */
export const TOO_MANY_ERRORS = {
  code: "eval.too_many_errors",
  message: "The eval run stopped after too many consecutive failed results",
} as const;

/**
 * 记一条结果的结局（熔断，C7 之外的保护）：出错 → `consecutive_errors + 1`，达到 `maxConsecutive` 且运行仍在执行时
 * 同一语句置 `failed`、记原因与 `finished_at`；成功 → 清零。返回运行是否因此被熔断。
 * 多个任务并发时「连续」按写入顺序计（近似），足以挡住「每个请求都失败」的运行。
 */
export async function recordOutcome(
  db: KernelDb,
  runId: string,
  ok: boolean,
  maxConsecutive: number,
): Promise<{ tripped: boolean }> {
  if (ok) {
    await db
      .updateTable("eval_runs")
      .set({ consecutive_errors: 0 })
      .where("id", "=", runId)
      .where("consecutive_errors", ">", 0)
      .execute();
    return { tripped: false };
  }
  const trips = sql<boolean>`consecutive_errors + 1 >= ${maxConsecutive} AND status IN ('queued', 'running')`;
  const r = await db
    .updateTable("eval_runs")
    .set({
      consecutive_errors: sql`consecutive_errors + 1`,
      status: sql`CASE WHEN ${trips} THEN 'failed' ELSE status END`,
      error: sql`CASE WHEN ${trips} THEN ${JSON.stringify(TOO_MANY_ERRORS)}::jsonb ELSE error END`,
      finished_at: sql`CASE WHEN ${trips} THEN now() ELSE finished_at END`,
    })
    .where("id", "=", runId)
    .returning(["status", "error"])
    .executeTakeFirst();
  return {
    tripped:
      r?.status === "failed" &&
      (r.error as { code?: string } | null)?.code === TOO_MANY_ERRORS.code,
  };
}

/**
 * 运行停下（取消 / 越限 / 熔断 / 删除评测集）时：还在等评委的结果（`judge_status = 'pending'`）记 `skipped`，
 * 否则这些用例永远算不上做完。给了 `caseId` 只处理该用例。在途的评委请求做完后写不进来（条件是 pending），用量照样计入。
 */
export async function skipPendingJudges(
  db: KernelDb,
  runId: string,
  caseId?: string,
): Promise<void> {
  let q = db
    .updateTable("eval_results")
    .set({ judge_status: "skipped", updated_at: sql`now()` })
    .where("run_id", "=", runId)
    .where("judge_status", "=", "pending");
  if (caseId !== undefined) q = q.where("case_id", "=", caseId);
  await q.execute();
}

/**
 * 重算 `cases_done` = 结果全部结束、且没有等评委的结果的用例数（幂等：任务重做不会重复计数），达到 `cases_total` 且运行仍在执行 →
 * `completed`。先锁运行行再数（READ COMMITTED 下新语句看得到其他任务已提交的结果），并发完成的任务不会互相覆盖。
 * worker 每做完一个用例、取消、入队失败时都调用。在事务里调用时锁随事务释放。
 */
export async function recountCases(db: KernelDb, runId: string): Promise<void> {
  const run = async (trx: KernelDb) => {
    const row = await trx
      .selectFrom("eval_runs")
      .select(["cases_total", "status"])
      .where("id", "=", runId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    const r = await sql<{ n: string }>`
      SELECT count(*) AS n FROM (
        SELECT case_id FROM capybara.eval_results WHERE run_id = ${runId}
        GROUP BY case_id
        HAVING bool_and(status IN ('done', 'error', 'skipped') AND judge_status <> 'pending')
      ) finished`.execute(trx);
    const done = Number(r.rows[0]?.n ?? 0);
    const complete =
      done >= row.cases_total && (ACTIVE_EVAL_STATUSES as readonly string[]).includes(row.status);
    await trx
      .updateTable("eval_runs")
      .set({
        cases_done: done,
        ...(complete && { status: "completed" as const, finished_at: sql`now()` }),
      })
      .where("id", "=", runId)
      .execute();
  };
  if (db.isTransaction) await run(db);
  else await db.transaction().execute((trx) => run(trx));
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
