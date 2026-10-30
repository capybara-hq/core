import type { ModelUsage } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";

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
  db: KernelSchemaDb,
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
  db: KernelSchemaDb,
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
  const tripped =
    r?.status === "failed" && (r.error as { code?: string } | null)?.code === TOO_MANY_ERRORS.code;
  // 熔断：整个运行还在等的评委都记 skipped（与取消一致；在途的评委做完后写不进来）
  if (tripped) await skipPendingJudges(db, runId);
  return { tripped };
}

/**
 * 运行停下（取消 / 越限 / 熔断 / 删除评测集）时：还在等评委的结果（`judge_status = 'pending'`）记 `skipped`，
 * 否则这些用例永远算不上做完。给了 `caseId` 只处理该用例。在途的评委请求做完后写不进来（条件是 pending），用量照样计入。
 */
export async function skipPendingJudges(
  db: KernelSchemaDb,
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
 * 运行仍在执行（queued / running），且所属组织与评测集的 agent 都没有删除：取消、达到上限、已结束、运行行已删除、
 * 组织或 agent 已删除都为 false（删除组织 / agent 时会显式取消运行，这里再兜一次底，挡住删除与请求之间的竞争）。
 */
export async function runActive(db: KernelSchemaDb, runId: string): Promise<boolean> {
  const r = await db
    .selectFrom("eval_runs as r")
    .innerJoin("eval_sets as s", "s.id", "r.set_id")
    .innerJoin("agents as a", "a.id", "s.agent_id")
    .innerJoin("orgs as o", "o.id", "r.org_id")
    .select("r.id")
    .where("r.id", "=", runId)
    .where("r.status", "in", [...ACTIVE_EVAL_STATUSES])
    .where("a.deleted_at", "is", null)
    .where("o.deleted_at", "is", null)
    .executeTakeFirst();
  return r !== undefined;
}

/**
 * The eval run bookkeeping that needs a transaction: the progress recount (it locks the run row)
 * and the cancellation of an org's or agent's runs when it is deleted. One provider, shared by the
 * evals, the agents and the orgs.
 */
@Injectable()
export class EvalBudget {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * 重算 `cases_done` = 结果全部结束、且没有等评委的结果的用例数（幂等：任务重做不会重复计数），达到 `cases_total` 且运行仍在执行 →
   * `completed`。先锁运行行再数（READ COMMITTED 下新语句看得到其他任务已提交的结果），并发完成的任务不会互相覆盖。
   * worker 每做完一个用例、取消、入队失败时都调用。Joins the caller's transaction (the lock is released with it),
   * else runs in its own.
   */
  @Transactional()
  async recountCases(runId: string): Promise<void> {
    const db = this.db.db;
    const row = await db
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
      ) finished`.execute(db);
    const done = Number(r.rows[0]?.n ?? 0);
    const complete =
      done >= row.cases_total && (ACTIVE_EVAL_STATUSES as readonly string[]).includes(row.status);
    await db
      .updateTable("eval_runs")
      .set({
        cases_done: done,
        ...(complete && { status: "completed" as const, finished_at: sql`now()` }),
      })
      .where("id", "=", runId)
      .execute();
  }

  /**
   * 删除组织或 agent 时（调用方的事务内）取消其在执行的评测运行：运行置 `cancelled`，未开始的结果 `skipped`、
   * 等评委的记 `skipped`，重算进度，每个运行写审计 `eval.run_cancelled`（detail 带原因）。在途请求做完后写不进新的请求
   * （worker 每次请求前查 {@link runActive}）。运行创建者离开组织不取消（Ruling S1-b：管理员的评测运行是组织的工作）。
   */
  @Transactional({ propagation: "mandatory" })
  async cancelRuns(
    scope: { orgId: string; agentId?: string },
    actor: { accountId: string; tokenId?: string },
    reason: "org_deleted" | "agent_deleted",
  ): Promise<string[]> {
    const db = this.db.db;
    let q = db
      .updateTable("eval_runs")
      .set({ status: "cancelled", finished_at: sql`now()` })
      .where("org_id", "=", scope.orgId)
      .where("status", "in", [...ACTIVE_EVAL_STATUSES]);
    if (scope.agentId !== undefined) {
      const agentId = scope.agentId;
      q = q.where("set_id", "in", (eb) =>
        eb.selectFrom("eval_sets").select("id").where("agent_id", "=", agentId),
      );
    }
    const runs = await q.returning("id").execute();
    for (const r of runs) {
      await this.skipRun(r.id);
      await audit(db, {
        actorAccountId: actor.accountId,
        ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
        orgId: scope.orgId,
        action: "eval.run_cancelled",
        target: r.id,
        detail: { reason },
      });
    }
    return runs.map((r) => r.id);
  }

  /**
   * A run that stopped (cancelled, its set deleted): its results not started yet are `skipped`,
   * the pending judges too, and the progress is recounted, in the caller's transaction.
   */
  @Transactional({ propagation: "mandatory" })
  async skipRun(runId: string): Promise<void> {
    await this.db
      .updateTable("eval_results")
      .set({ status: "skipped", updated_at: sql`now()` })
      .where("run_id", "=", runId)
      .where("status", "=", "pending")
      .execute();
    await skipPendingJudges(this.db.db, runId);
    await this.recountCases(runId);
  }
}

/** {@link EvalBudget} on its own: the agents and the orgs import it without the evals. */
@Module({ providers: [EvalBudget], exports: [EvalBudget] })
export class EvalBudgetModule {}

export const addUsage = (a: ModelUsage, b: ModelUsage): ModelUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});
