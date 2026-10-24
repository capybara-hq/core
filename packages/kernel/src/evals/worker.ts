import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ContentBlock } from "@capybara-hq/plugin-sdk";
import { isModelError, isRetryableKind, type Logger } from "@capybara-hq/plugin-sdk";
import { DelayedError, type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionUnloadedError } from "../extensions/inflight.js";
import { type ModelPurposesService, PurposeAttemptError } from "../models/purposes.js";
import { MediaUnavailableError, RunError } from "../runtime/model-call.js";
import { ProviderListError } from "../runtime/providers.js";
import { ORG_QUOTA_LEASE_MS, type OrgQuota } from "../runtime/quota.js";
import { bullConnection } from "../runtime/run-queue.js";
import {
  consumeTokens,
  recordOutcome,
  recountCases,
  runActive,
  skipPendingJudges,
  usageTokens,
} from "./budget.js";
import { replyParts, structuralDiff } from "./diff.js";
import { JUDGE_PROVIDER_UNAVAILABLE, judge } from "./judge.js";
import { userRequestOf } from "./plan.js";
import type { DriftReason } from "./reconstruct.js";
import {
  deleteEvalConversation,
  ReplayClaimLost,
  type RunReplayDeps,
  replayRun,
  runBaseline,
} from "./run-replay.js";
import {
  caseBase,
  EVAL_QUEUE_NAME,
  type EvalCandidate,
  type EvalJobData,
  evalJobId,
  versionDefinition,
} from "./runs.service.js";
import { type CaseSnapshot, readSnapshot, replayableCalls } from "./snapshot.js";
import {
  ReplayAttemptError,
  replayStep,
  resolveCandidate,
  type StepReplayDeps,
} from "./step-replay.js";

/**
 * 评测 worker（C7，只在含 `worker` 角色的进程启动）：领取 `cap-kernel-evals` 的任务，每个任务回放一个用例。
 * - 运行不活跃（取消 / 达到上限 / 熔断 / 已结束）→ 该用例剩余结果标 `skipped`；
 * - 组织并发配额 `capk:org-evals:<orgId>`（`evals.orgConcurrency`，成员为 jobId + 认领号）拿不到 → 延后 5000ms；
 * - 每次请求前查 `runActive`（含组织 / agent 未删除）与认领；成功的请求在同一事务里写结果并 `consumeTokens`（越限即 `capped`），
 *   发出后失败的尝试按估算同样 `consumeTokens`；
 * - 可重试的错误重试 3 次，不可重试的结果标 `error`；连续 `evals.maxConsecutiveErrors` 条结果出错 → 运行 `failed`；
 * - 结果按认领号（每次执行一个 uuid）写入：失去认领的旧执行写不进来（已发出请求的用量照样计入）；
 * - 结果写 done 时一并写结构差异（`diff`）；开了评委时随后（运行仍活跃才）发一次评委请求，结论写进 `judge`，
 *   用量同样 `consumeTokens`（请求失败按估算）；
 * - 用例做完重算 `cases_done`（已全部结束的用例数，幂等），达到总数且仍在执行 → `completed`。
 * 多副本：状态全在 PG / Redis；崩溃的任务由 BullMQ stalled 机制交给别的 worker，`running` 的结果从头重做；
 * 处理函数外的暂时故障（PG / Redis）按任务的 attempts 指数退避重试。
 */

/** 拿不到组织配额时任务延后的毫秒数。 */
export const EVAL_QUOTA_RETRY_MS = 5000;

/** 可重试错误的最多重试次数。 */
export const EVAL_MAX_RETRIES = 3;

/** 第 n 次重试前的等待（毫秒）；供应商给了 `retryAfterMs` 时取它（不超过 30 秒）。 */
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 30_000;

const MAX_STALLED_COUNT = 3;

export interface EvalWorkerDeps {
  db: KernelDb;
  redisUrl: string;
  /** 评测配额（`new OrgQuota(redis, EVAL_QUOTA_PREFIX)`）。 */
  quota: OrgQuota;
  config: () => KernelConfig;
  log: Logger;
  replay: StepReplayDeps;
  /** 整轮回放（mode = run）的依赖；认领相关的两项由 worker 按每次执行补上。 */
  runReplay: Omit<RunReplayDeps, "stillClaimed" | "onSeeded">;
  /** 评委（用途 `eval`，D3）：开了评委的运行每条 done 的结果发一次评委请求。 */
  purposes: Pick<ModelPurposesService, "chat">;
  /** 测试用：覆盖拿不到配额时的延后时长。 */
  quotaRetryMs?: number;
}

interface Failure {
  retryable: boolean;
  code: string;
  message: string;
  retryAfterMs?: number;
}

/** 供应商插件在调用途中被撤销（错误本身或其 cause）。 */
const isPluginUnloaded = (err: unknown): boolean =>
  err instanceof ExtensionUnloadedError ||
  (err instanceof Error && err.cause instanceof ExtensionUnloadedError);

/** 回放出错的分类（与运行时的降级梯子同一套码）。 */
function classify(err: unknown): Failure {
  if (isModelError(err)) {
    return {
      retryable: isRetryableKind(err.kind),
      code: `model.${err.kind}`,
      message: err.message,
      ...(err.retryAfterMs !== undefined && { retryAfterMs: err.retryAfterMs }),
    };
  }
  if (err instanceof MediaUnavailableError) {
    return { retryable: true, code: "run.storage_unavailable", message: err.message };
  }
  // 整轮回放的 loop 失败（降级梯子已在 loop 内重试过）：沿用运行时的码
  if (err instanceof RunError) return { retryable: false, code: err.code, message: err.message };
  // 供应商插件在请求途中被撤销 / 升级 / 重新加载：与运行时一致按可重试处理，重试时实时取到新实例
  if (isPluginUnloaded(err) || err instanceof ProviderListError) {
    return {
      retryable: true,
      code: "run.provider_unavailable",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (err instanceof ApiError) {
    const code = err.code === "agent.model_unavailable" ? "run.model_unavailable" : err.code;
    return { retryable: false, code, message: err.message };
  }
  return {
    retryable: false,
    code: "run.provider_error",
    message: err instanceof Error ? err.message : String(err),
  };
}

/** 回放本身的失败（结果记 error）；其余错误按崩溃处理（见 runWhole）。 */
const isReplayFailure = (err: unknown): boolean =>
  isModelError(err) ||
  err instanceof RunError ||
  err instanceof ApiError ||
  err instanceof MediaUnavailableError ||
  err instanceof ProviderListError ||
  isPluginUnloaded(err);

class Aborted extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted());
    const onAbort = () => {
      clearTimeout(t);
      reject(new Aborted());
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const UNFINISHED = ["pending", "running"] as const;

/** 给评委看的回复：工具调用（名字与参数）在前，文本在后。 */
function renderReply(toolCalls: { name: string; input: unknown }[], text: string): string {
  const calls = toolCalls.map((c) => `Tool call: ${c.name} ${JSON.stringify(c.input ?? null)}`);
  return [...calls, text].filter((x) => x.length > 0).join("\n");
}

/** 一次运行的评分设置。 */
interface Grading {
  judge: boolean;
  rubric: string | null;
}

/** 一边（基线或候选）给评委看的内容：单步取回复的内容块，整轮取工具调用序列与最后的回复。 */
function sideOf(
  mode: "step" | "run",
  v: unknown,
): { toolCalls: { name: string; input: unknown }[]; text: string } {
  if (mode === "step") return replyParts((v as { content?: ContentBlock[] } | null)?.content ?? []);
  const r = v as {
    toolCalls?: { name: string; input: unknown }[];
    finalContent?: ContentBlock[];
  } | null;
  return { toolCalls: r?.toolCalls ?? [], text: replyParts(r?.finalContent ?? []).text };
}

/**
 * 评委的输入（由结果里存的基线 / 候选得出，崩溃后补评委时同样可用）：用户请求 = 该调用（整轮为原运行开始）之前
 * 最近一条用户消息；回复 = 工具调用在前、文本在后。
 */
function judgeInputOf(
  s: CaseSnapshot,
  mode: "step" | "run",
  modelCallSeq: number | null,
  baseline: unknown,
  candidate: unknown,
  rubric: string | null,
): Parameters<typeof judge>[2] {
  const start = s.events.find((e) => e.runId === s.runId && e.type === "run_started");
  const before =
    mode === "step" && modelCallSeq !== null
      ? modelCallSeq
      : (start?.seq ?? Number.POSITIVE_INFINITY);
  const b = sideOf(mode, baseline);
  const c = sideOf(mode, candidate);
  return {
    userRequest: userRequestOf(s, before),
    baseline: renderReply(b.toolCalls, b.text),
    candidate: renderReply(c.toolCalls, c.text),
    rubric,
  };
}

export class EvalWorker {
  private worker: Worker<EvalJobData> | undefined;
  private conn: Redis | undefined;
  /** 本进程在执行的任务：停机时中止，任务回到队列。 */
  private readonly active = new Set<AbortController>();
  private closing = false;

  constructor(private readonly d: EvalWorkerDeps) {}

  start(): void {
    if (this.worker) return;
    const { runtime, evals } = this.d.config();
    this.conn = bullConnection(this.d.redisUrl, this.d.log);
    this.worker = new Worker<EvalJobData>(
      EVAL_QUEUE_NAME,
      (job, token) => this.process(job, token),
      {
        name: `${hostname()}-${process.pid}`,
        connection: this.conn,
        concurrency: evals.workerConcurrency,
        lockDuration: runtime.jobLockMs,
        stalledInterval: runtime.stalledIntervalMs,
        maxStalledCount: MAX_STALLED_COUNT,
      },
    );
    this.worker.on("error", (err) => this.d.log.error("eval worker error", { err }));
    this.worker.on("failed", (job, err) => {
      if (!job) return;
      // 处理函数外的暂时故障（PG / Redis）由 BullMQ 按 attempts 指数退避重试；用尽（或 stalled 超限）才算失败
      if (job.attemptsMade < (job.opts.attempts ?? 1) && !/stalled/i.test(err.message)) {
        this.d.log.warn("eval job attempt failed; retrying", { jobId: job.id, err });
        return;
      }
      this.d.log.error("eval job failed", { jobId: job.id, err });
      // 任务不会再执行：该用例剩下的结果记 error，运行不因此卡住
      void this.failCase(job.data, err).catch((e) =>
        this.d.log.error("cannot mark failed eval job", { jobId: job.id, err: e }),
      );
    });
  }

  /** 停止领取；中止本进程在执行的任务（回到队列由别的 worker 接着做），在 budgetMs 内等它们退出。 */
  async close(budgetMs: number): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    this.closing = true;
    await worker.pause(true).catch(() => {});
    for (const ac of this.active) ac.abort();
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      worker.close().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, budgetMs));
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (!done) await worker.close(true).catch(() => {});
    this.conn?.disconnect();
  }

  private async process(job: Job<EvalJobData>, token: string | undefined): Promise<void> {
    const data = job.data;
    const { runId, orgId } = data;
    const jobId = job.id ?? evalJobId(runId, data.caseId);
    if (!(await runActive(this.d.db, runId))) {
      await this.skipCase(data);
      await recountCases(this.d.db, runId);
      return;
    }
    const limit = this.d.config().evals.orgConcurrency;
    // 每次执行一个新的认领号：失去认领（stalled 后被别的 worker 接手）的旧执行写不进结果（用量照样计入）。
    // 配额成员 = 任务 id + 认领号：旧执行退出时只移除自己的名额，不会把接手执行的名额一起移掉
    const claim = randomUUID();
    const member = `${jobId}-${claim}`;
    if (!(await this.d.quota.tryEnter(orgId, member, limit, ORG_QUOTA_LEASE_MS))) {
      // 配额满：固定 5 秒后再试，不按事件唤醒。评测是后台批任务，几秒空等可以接受，换来没有跨副本通知
      await job.moveToDelayed(Date.now() + (this.d.quotaRetryMs ?? EVAL_QUOTA_RETRY_MS), token);
      throw new DelayedError();
    }
    const ac = new AbortController();
    this.active.add(ac);
    if (this.closing) ac.abort();
    const renew = setInterval(() => {
      this.d.quota
        .renew(orgId, member, ORG_QUOTA_LEASE_MS)
        .catch((err) => this.d.log.warn("eval quota renew failed", { jobId, err }));
    }, ORG_QUOTA_LEASE_MS / 3);
    renew.unref();
    try {
      await this.d.db
        .updateTable("eval_runs")
        .set({ status: "running", started_at: sql`COALESCE(started_at, now())` })
        .where("id", "=", runId)
        .where("status", "=", "queued")
        .execute();
      await this.runCase(data, claim, ac.signal);
    } catch (err) {
      if (ac.signal.aborted) {
        // 停机：任务回到队列，`running` 的结果由接手的 worker 重做
        await job.moveToDelayed(Date.now(), token);
        throw new DelayedError();
      }
      throw err;
    } finally {
      clearInterval(renew);
      this.active.delete(ac);
      await this.d.quota
        .leave(orgId, member)
        .catch((err) => this.d.log.warn("eval quota leave failed", { jobId, err }));
    }
    await recountCases(this.d.db, runId);
  }

  /** 单步回放每次请求前：运行仍在执行（{@link runActive}）且结果仍由本次执行认领。 */
  private async mayRequest(
    runId: string,
    resultId: string,
    claim: string,
  ): Promise<"ok" | "inactive" | "lost"> {
    if (!(await runActive(this.d.db, runId))) return "inactive";
    const held = await this.d.db
      .selectFrom("eval_results")
      .select("id")
      .where("id", "=", resultId)
      .where("status", "=", "running")
      .where("claimed_by", "=", claim)
      .executeTakeFirst();
    return held ? "ok" : "lost";
  }

  /**
   * 一条结果出错：只在仍由本次执行认领时写入，然后计入熔断；熔断 → 该用例剩下的结果 skipped（其他用例的任务
   * 看到运行不活跃也会跳过）。返回 true 表示本用例应停下（熔断或失去认领）。
   */
  private async resultError(
    data: EvalJobData,
    resultId: string,
    claim: string,
    error: { code: string; message: string },
  ): Promise<boolean> {
    const db = this.d.db;
    const w = await db
      .updateTable("eval_results")
      .set({ status: "error", error: JSON.stringify(error), updated_at: sql`now()` })
      .where("id", "=", resultId)
      .where("status", "=", "running")
      .where("claimed_by", "=", claim)
      .executeTakeFirst();
    if (Number(w.numUpdatedRows) === 0) return true;
    const { tripped } = await recordOutcome(
      db,
      data.runId,
      false,
      this.d.config().evals.maxConsecutiveErrors,
    );
    if (tripped) {
      this.d.log.warn("eval run stopped after too many consecutive errors", { runId: data.runId });
      await this.skipCase(data);
      return true;
    }
    return false;
  }

  /** 回放一个用例的全部未结束结果（按调用顺序）。 */
  private async runCase(data: EvalJobData, claim: string, signal: AbortSignal): Promise<void> {
    const { runId, caseId } = data;
    const db = this.d.db;
    const [row, run] = await Promise.all([
      db.selectFrom("eval_cases").select("snapshot").where("id", "=", caseId).executeTakeFirst(),
      db
        .selectFrom("eval_runs")
        .innerJoin("eval_sets", "eval_sets.id", "eval_runs.set_id")
        .select(["eval_runs.candidate", "eval_runs.mode", "eval_runs.judge", "eval_sets.rubric"])
        .where("eval_runs.id", "=", runId)
        .executeTakeFirst(),
    ]);
    if (!row || !run) return;
    const grade: Grading = { judge: run.judge, rubric: run.rubric };
    const s = readSnapshot(row.snapshot);
    const candidate = run.candidate as EvalCandidate;
    // 未结束的结果，以及已 done 但评委还没做的（上一次执行在评委之前崩溃 / 停机）
    const pending = await db
      .selectFrom("eval_results")
      .select(["id", "model_call_seq", "status"])
      .where("run_id", "=", runId)
      .where("case_id", "=", caseId)
      .where((eb) =>
        eb.or([
          eb("status", "in", [...UNFINISHED]),
          eb.and([eb("status", "=", "done"), eb("judge_status", "=", "pending")]),
        ]),
      )
      .orderBy("model_call_seq")
      .execute();
    if (pending.length === 0) return;

    const base = await caseBase(db, s);
    const resolved = base
      ? resolveCandidate(
          base,
          candidate,
          await versionDefinition(db, s.agentId, candidate.agentVersion),
        )
      : null;
    const mode = run.mode;
    if (mode === "run") {
      const [r] = pending;
      if (!r) return;
      if (r.status === "done") await this.judgeLeftover(data, r.id, claim, signal, s, mode, grade);
      else await this.runWhole(data, claim, signal, s, resolved, r.id, grade);
      return;
    }
    const calls = new Map(replayableCalls(s).map((c) => [c.seq, c]));

    for (const r of pending) {
      if (signal.aborted) throw new Aborted();
      if (!(await runActive(db, runId))) {
        await this.skipCase(data);
        return;
      }
      if (r.status === "done") {
        const j = await this.judgeLeftover(data, r.id, claim, signal, s, mode, grade);
        if (j === "capped") {
          await this.skipCase(data);
          return;
        }
        continue;
      }
      const claimed = await db
        .updateTable("eval_results")
        .set({ status: "running", claimed_by: claim, updated_at: sql`now()` })
        .where("id", "=", r.id)
        .where("status", "in", [...UNFINISHED])
        .returning("id")
        .executeTakeFirst();
      if (!claimed) continue;
      const call = calls.get(Number(r.model_call_seq));
      if (!resolved || !call) {
        const error = !resolved
          ? {
              code: "eval.definition_missing",
              message: "The agent version of this case is missing",
            }
          : {
              code: "eval.call_not_found",
              message: "The model call is not replayable in this snapshot",
            };
        if (await this.resultError(data, r.id, claim, error)) return;
        continue;
      }

      let out: Awaited<ReturnType<typeof replayStep>> | undefined;
      let failure: Failure | undefined;
      for (let attempt = 0; ; attempt++) {
        // 每次请求前（含重试）：运行仍在执行（取消 / 越限 / 熔断 / 组织或 agent 删除后不再发），且仍由本次执行认领
        // （stalled 后被接手的旧执行不再发）
        const may = await this.mayRequest(runId, r.id, claim);
        if (may === "lost") return;
        if (may === "inactive") {
          await this.skipCase(data);
          return;
        }
        try {
          out = await replayStep(this.d.replay, s, call, resolved, signal);
          break;
        } catch (err) {
          // 已发出的请求没有正常收完：按估算计入预算（与成功的请求走同一个原子累加，越限同样置 capped）。
          // 不以认领为条件：钱已经花出去了
          if (err instanceof ReplayAttemptError) await consumeTokens(db, runId, err.tokens);
          if (signal.aborted) throw new Aborted();
          const f = classify(err instanceof ReplayAttemptError ? err.cause : err);
          if (!f.retryable || attempt >= EVAL_MAX_RETRIES) {
            failure = f;
            break;
          }
          const wait = Math.min(
            f.retryAfterMs ?? RETRY_DELAYS_MS[attempt] ?? 4000,
            MAX_RETRY_AFTER_MS,
          );
          await sleep(wait, signal);
        }
      }
      if (!out) {
        const f = failure as Failure;
        if (await this.resultError(data, r.id, claim, { code: f.code, message: f.message })) {
          return;
        }
        continue;
      }
      const result = out;
      const tokens = usageTokens(result.candidate.usage);
      const b = replyParts(result.baseline.content);
      const c = replyParts(result.candidate.content);
      const diff = structuralDiff(
        { ...b, stopReason: result.baseline.stopReason },
        { ...c, stopReason: result.candidate.stopReason },
      );
      const outcome = await db.transaction().execute(async (trx) => {
        // 只在仍由本次执行认领时写结果：stalled 后被接手的旧执行不覆盖结果。用量照样计入（请求确实发出且已付费，
        // 与失败尝试一样不以认领为条件），走同一个原子 consumeTokens
        const w = await trx
          .updateTable("eval_results")
          .set({
            status: "done",
            baseline: JSON.stringify(result.baseline),
            candidate: JSON.stringify(result.candidate),
            diff: JSON.stringify(diff),
            // 开了评委：评委做完之前用例不算做完（recountCases 不计 pending 的评委）
            judge_status: grade.judge ? "pending" : "none",
            drift: result.drift,
            error: null,
            updated_at: sql`now()`,
          })
          .where("id", "=", r.id)
          .where("status", "=", "running")
          .where("claimed_by", "=", claim)
          .executeTakeFirst();
        if (Number(w.numUpdatedRows) === 0) {
          await consumeTokens(trx, runId, tokens);
          return "lost" as const;
        }
        await recordOutcome(trx, runId, true, this.d.config().evals.maxConsecutiveErrors);
        const { capped } = await consumeTokens(trx, runId, tokens);
        return capped ? ("capped" as const) : ("ok" as const);
      });
      // 失去认领：这个用例已由别的执行接手，本次停下
      if (outcome === "lost") return;
      if (outcome === "capped") {
        await this.skipCase(data);
        return;
      }
      if (grade.judge) {
        const j = await this.judgeResult(
          data,
          r.id,
          claim,
          signal,
          judgeInputOf(s, mode, call.seq, result.baseline, result.candidate, grade.rubric),
        );
        if (j === "capped") {
          await this.skipCase(data);
          return;
        }
      }
    }
  }

  /**
   * 补做评委：结果已 done、`judge_status = 'pending'`（上一次执行在评委之前崩溃 / 停机）。按本次执行的认领号重新认领
   * （条件仍是 done + pending），由结果里存的基线 / 候选得出评委输入；候选请求不重发。
   */
  private async judgeLeftover(
    data: EvalJobData,
    resultId: string,
    claim: string,
    signal: AbortSignal,
    s: CaseSnapshot,
    mode: "step" | "run",
    grade: Grading,
  ): Promise<"ok" | "capped" | "inactive" | "lost"> {
    const row = await this.d.db
      .updateTable("eval_results")
      .set({ claimed_by: claim, updated_at: sql`now()` })
      .where("id", "=", resultId)
      .where("status", "=", "done")
      .where("judge_status", "=", "pending")
      .returning(["model_call_seq", "baseline", "candidate"])
      .executeTakeFirst();
    if (!row) return "lost";
    const seq = row.model_call_seq === null ? null : Number(row.model_call_seq);
    return this.judgeResult(
      data,
      resultId,
      claim,
      signal,
      judgeInputOf(s, mode, seq, row.baseline, row.candidate, grade.rubric),
    );
  }

  /**
   * 评委（结果已写 done、`judge_status = 'pending'` 之后）：
   * - 运行不再活跃（取消 / 越限 / 熔断）→ 不发请求，评委记 `skipped`；
   * - 先按用量（失败按估算）`consumeTokens`，不以认领为条件（请求确实发出了）；再在仍由本次执行认领、且仍是 pending
   *   时写结论（`judge_status` done / error）。写之前出 DB 错误按崩溃处理：重试时补评委（会再发一次评委请求）；
   * - 停机中止：已发出的评委请求按估算计费，任务回到队列，接手的执行补评委。
   * 供应商插件在评委请求途中被撤销（`run.provider_unavailable`）→ 按估算计费后重试，至多 {@link EVAL_MAX_RETRIES} 次；
   * 评委失败不计入熔断（结果本身是 done）。返回 `capped` 表示评委的用量让运行达到上限。
   */
  private async judgeResult(
    data: EvalJobData,
    resultId: string,
    claim: string,
    signal: AbortSignal,
    input: Parameters<typeof judge>[2],
  ): Promise<"ok" | "capped" | "inactive"> {
    const db = this.d.db;
    if (!(await runActive(db, data.runId))) {
      await db
        .updateTable("eval_results")
        .set({ judge_status: "skipped", updated_at: sql`now()` })
        .where("id", "=", resultId)
        .where("judge_status", "=", "pending")
        .execute();
      return "inactive";
    }
    await this.d.runReplay.hooks?.beforeJudge?.(data.runId);
    let v: Awaited<ReturnType<typeof judge>>;
    for (let attempt = 0; ; attempt++) {
      try {
        v = await judge(
          {
            purposes: this.d.purposes,
            maxOutputTokens: this.d.config().evals.judgeMaxOutputTokens,
          },
          data.orgId,
          input,
          signal,
        );
      } catch (err) {
        // 中止时已发出的评委请求：按估算计费（与失败的回放尝试一致）
        if (err instanceof PurposeAttemptError) await consumeTokens(db, data.runId, err.tokens);
        if (signal.aborted) throw new Aborted();
        throw err;
      }
      // 供应商插件在评委请求途中被撤销 / 升级：失败的尝试按估算计费，运行仍活跃时重试（实时取到新实例）
      if (
        !("error" in v) ||
        v.error !== JUDGE_PROVIDER_UNAVAILABLE ||
        attempt >= EVAL_MAX_RETRIES
      ) {
        break;
      }
      const { capped } = await consumeTokens(db, data.runId, v.tokens);
      if (capped || !(await runActive(db, data.runId))) {
        await db
          .updateTable("eval_results")
          .set({ judge_status: "skipped", updated_at: sql`now()` })
          .where("id", "=", resultId)
          .where("judge_status", "=", "pending")
          .execute();
        return capped ? "capped" : "inactive";
      }
      await sleep(RETRY_DELAYS_MS[attempt] ?? 4000, signal);
    }
    const tokens = "error" in v ? v.tokens : usageTokens(v.usage);
    const { capped } = await consumeTokens(db, data.runId, tokens);
    const stored =
      "error" in v
        ? {
            error: v.error,
            ...(v.provider !== undefined && { provider: v.provider }),
            ...(v.model !== undefined && { model: v.model }),
          }
        : v;
    await db
      .updateTable("eval_results")
      .set({
        judge: JSON.stringify(stored),
        judge_status: "error" in v ? "error" : "done",
        updated_at: sql`now()`,
      })
      .where("id", "=", resultId)
      .where("status", "=", "done")
      .where("judge_status", "=", "pending")
      .where("claimed_by", "=", claim)
      .execute();
    if (signal.aborted) throw new Aborted();
    return capped ? "capped" : "ok";
  }

  /**
   * 整轮回放一个用例（一条结果）。认领结果后先删掉上一次执行留下的评测对话（崩溃重跑从头开始，C6），
   * 再 {@link replayRun}；计费在每次模型请求上完成（含失败与失去认领的请求）。
   * - 运行不再活跃（取消 / 越限 / 熔断）→ 结果 skipped；失去认领 → 停下，不写；
   * - 回放出错 → 结果 error 并计入熔断；停机 → 任务回到队列，接手的执行从头重跑。
   */
  private async runWhole(
    data: EvalJobData,
    claim: string,
    signal: AbortSignal,
    s: CaseSnapshot,
    resolved: ReturnType<typeof resolveCandidate> | null,
    resultId: string,
    grade: Grading,
  ): Promise<void> {
    const { runId } = data;
    const db = this.d.db;
    if (!(await runActive(db, runId))) {
      await this.skipCase(data);
      return;
    }
    const claimed = await db
      .updateTable("eval_results")
      .set({ status: "running", claimed_by: claim, updated_at: sql`now()` })
      .where("id", "=", resultId)
      .where("status", "in", [...UNFINISHED])
      .returning("eval_conversation_id")
      .executeTakeFirst();
    if (!claimed) return;
    if (claimed.eval_conversation_id !== null) {
      await deleteEvalConversation(this.d.runReplay, claimed.eval_conversation_id);
    }
    if (!resolved) {
      await this.resultError(data, resultId, claim, {
        code: "eval.definition_missing",
        message: "The agent version of this case is missing",
      });
      return;
    }
    const held = async (q: KernelDb = db) =>
      (await q
        .selectFrom("eval_results")
        .select("id")
        .where("id", "=", resultId)
        .where("status", "=", "running")
        .where("claimed_by", "=", claim)
        .executeTakeFirst()) !== undefined;
    let out: Awaited<ReturnType<typeof replayRun>>;
    try {
      out = await replayRun(
        {
          ...this.d.runReplay,
          stillClaimed: () => held(),
          onSeeded: async (trx, conversationId) => {
            const w = await trx
              .updateTable("eval_results")
              .set({ eval_conversation_id: conversationId, updated_at: sql`now()` })
              .where("id", "=", resultId)
              .where("status", "=", "running")
              .where("claimed_by", "=", claim)
              .executeTakeFirst();
            return Number(w.numUpdatedRows) > 0;
          },
        },
        s,
        resolved,
        runId,
        signal,
      );
    } catch (err) {
      if (signal.aborted) throw new Aborted();
      if (err instanceof ReplayClaimLost) {
        if (!(await runActive(db, runId))) await this.skipCase(data);
        return;
      }
      // 意外错误（PG / Redis 暂时故障、进程内异常）按崩溃处理：抛给 BullMQ 按 attempts 重试，
      // 下一次执行删掉这次的评测对话、从头重跑（C6）；用尽后 failed 事件把结果记 error
      if (!isReplayFailure(err)) throw err;
      const f = classify(err);
      await this.resultError(data, resultId, claim, { code: f.code, message: f.message });
      return;
    }
    if (signal.aborted) throw new Aborted();
    if (out.outcome === "aborted") {
      // 回放中途被停下（取消 / 越限 / 熔断 / 失去认领）：结果不完整。运行不再活跃 → skipped；
      // 运行仍活跃说明是失去认领，由接手的执行负责
      if (!(await runActive(db, runId))) await this.skipCase(data);
      return;
    }
    // 回放已完整做完：即使最后一次请求的用量刚好越限（运行已 capped），结果照常记 done（只要仍持有认领）
    if (!(await held())) return;
    const baseline = runBaseline(s);
    const drift: DriftReason[] = out.unmatched > 0 ? ["tool_unmatched"] : [];
    const baseText = replyParts(baseline.finalContent).text;
    const candText = replyParts(out.finalContent).text;
    const diff = structuralDiff(
      { toolCalls: baseline.toolCalls, text: baseText, stopReason: baseline.stopReason },
      { toolCalls: out.toolCalls, text: candText, stopReason: out.stopReason },
    );
    const written = await db.transaction().execute(async (trx) => {
      const w = await trx
        .updateTable("eval_results")
        .set({
          status: "done",
          baseline: JSON.stringify(baseline),
          candidate: JSON.stringify(out),
          diff: JSON.stringify(diff),
          judge_status: grade.judge ? "pending" : "none",
          drift,
          error: null,
          eval_conversation_id: out.conversationId,
          updated_at: sql`now()`,
        })
        .where("id", "=", resultId)
        .where("status", "=", "running")
        .where("claimed_by", "=", claim)
        .executeTakeFirst();
      if (Number(w.numUpdatedRows) === 0) return false;
      await recordOutcome(trx, runId, true, this.d.config().evals.maxConsecutiveErrors);
      return true;
    });
    if (!written || !grade.judge) return;
    await this.judgeResult(
      data,
      resultId,
      claim,
      signal,
      judgeInputOf(s, "run", null, baseline, out, grade.rubric),
    );
  }

  /**
   * 该用例剩下的结果标 skipped。整轮回放留下的评测对话里若还有没结束的运行（上一次执行崩溃在回放中途），删掉它，
   * 不留永远「执行中」的评测对话；已正常收尾（`run_aborted` / `run_finished`）的保留，轨迹里能看到停在哪里。
   * 清理失败只记日志，不挡住标 skipped（残留的随评测集或组织删除清掉）。
   */
  private async skipCase(data: EvalJobData): Promise<void> {
    const db = this.d.db;
    const left = await db
      .selectFrom("eval_results as er")
      .select(["er.id", "er.eval_conversation_id"])
      .where("er.run_id", "=", data.runId)
      .where("er.case_id", "=", data.caseId)
      .where("er.status", "in", [...UNFINISHED])
      .where("er.eval_conversation_id", "is not", null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("runs")
            .select("runs.id")
            .whereRef("runs.conversation_id", "=", "er.eval_conversation_id")
            .where("runs.status", "in", ["queued", "running"]),
        ),
      )
      .execute();
    for (const r of left) {
      try {
        await deleteEvalConversation(this.d.runReplay, r.eval_conversation_id as string);
        await db
          .updateTable("eval_results")
          .set({ eval_conversation_id: null })
          .where("id", "=", r.id)
          .execute();
      } catch (err) {
        this.d.log.warn("cannot delete the unfinished eval conversation of a skipped case", {
          runId: data.runId,
          caseId: data.caseId,
          err,
        });
      }
    }
    await db
      .updateTable("eval_results")
      .set({ status: "skipped", updated_at: sql`now()` })
      .where("run_id", "=", data.runId)
      .where("case_id", "=", data.caseId)
      .where("status", "in", [...UNFINISHED])
      .execute();
    await skipPendingJudges(db, data.runId, data.caseId);
  }

  /** BullMQ 判定任务失败（stalled 次数超限或重试用尽）：剩下的结果记 error，再重算进度。 */
  private async failCase(data: EvalJobData, err: Error): Promise<void> {
    const stalled = /stalled/i.test(err.message);
    // 整轮回放：尝试用尽后不会再有执行来清理，删掉留下的半截评测对话
    const left = await this.d.db
      .selectFrom("eval_results")
      .select("eval_conversation_id")
      .where("run_id", "=", data.runId)
      .where("case_id", "=", data.caseId)
      .where("status", "in", [...UNFINISHED])
      .where("eval_conversation_id", "is not", null)
      .execute();
    for (const r of left) {
      // 清理失败不能挡住记错误（否则结果一直 running、运行卡住）；残留的评测对话随评测集删除或组织删除清掉
      try {
        await deleteEvalConversation(this.d.runReplay, r.eval_conversation_id as string);
      } catch (e) {
        this.d.log.warn("cannot delete the eval conversation of a failed eval job", {
          runId: data.runId,
          caseId: data.caseId,
          err: e,
        });
      }
    }
    await this.d.db
      .updateTable("eval_results")
      .set({
        status: "error",
        error: JSON.stringify(
          stalled
            ? { code: "eval.stalled", message: "The replay was interrupted too many times" }
            : { code: "eval.internal", message: "The replay failed unexpectedly" },
        ),
        eval_conversation_id: null,
        updated_at: sql`now()`,
      })
      .where("run_id", "=", data.runId)
      .where("case_id", "=", data.caseId)
      .where("status", "in", [...UNFINISHED])
      .execute();
    // 已 done 但评委一直没做成的：评委记 skipped（结果本身保留）
    await skipPendingJudges(this.d.db, data.runId, data.caseId);
    await recountCases(this.d.db, data.runId);
  }
}
