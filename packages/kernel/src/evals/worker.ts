import { hostname } from "node:os";
import { isModelError, isRetryableKind, type Logger } from "@capybara-hq/plugin-sdk";
import { DelayedError, type Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { MediaUnavailableError } from "../runtime/model-call.js";
import { ProviderListError } from "../runtime/providers.js";
import { ORG_QUOTA_LEASE_MS, type OrgQuota } from "../runtime/quota.js";
import { bullConnection } from "../runtime/run-queue.js";
import { consumeTokens, runActive, usageTokens } from "./budget.js";
import {
  caseBase,
  EVAL_QUEUE_NAME,
  type EvalCandidate,
  type EvalJobData,
  evalJobId,
  versionDefinition,
} from "./runs.service.js";
import { type CaseSnapshot, replayableCalls } from "./snapshot.js";
import { replayStep, resolveCandidate, type StepReplayDeps } from "./step-replay.js";

/**
 * 评测 worker（C7，只在含 `worker` 角色的进程启动）：领取 `cap-kernel-evals` 的任务，每个任务回放一个用例。
 * - 运行不活跃（取消 / 达到上限 / 已结束）→ 该用例剩余结果标 `skipped`；
 * - 组织并发配额 `capk:org-evals:<orgId>`（`evals.orgConcurrency`，成员为 jobId）拿不到 → 延后 5000ms；
 * - 每次请求前查 `runActive`，请求后在同一事务里写结果并 `consumeTokens`（越限即 `capped`，不再发新请求）；
 * - 可重试的错误重试 3 次，不可重试的结果标 `error`；
 * - 用例做完重算 `cases_done`（已全部结束的用例数，幂等），达到总数且仍在执行 → `completed`。
 * 多副本：状态全在 PG / Redis；崩溃的任务由 BullMQ stalled 机制交给别的 worker，`running` 的结果从头重做。
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
  /** 测试用：覆盖拿不到配额时的延后时长。 */
  quotaRetryMs?: number;
}

interface Failure {
  retryable: boolean;
  code: string;
  message: string;
  retryAfterMs?: number;
}

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
  if (err instanceof ProviderListError) {
    return { retryable: true, code: "run.provider_unavailable", message: err.message };
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
      await this.finishCase(runId);
      return;
    }
    const limit = this.d.config().evals.orgConcurrency;
    if (!(await this.d.quota.tryEnter(orgId, jobId, limit, ORG_QUOTA_LEASE_MS))) {
      await job.moveToDelayed(Date.now() + (this.d.quotaRetryMs ?? EVAL_QUOTA_RETRY_MS), token);
      throw new DelayedError();
    }
    const ac = new AbortController();
    this.active.add(ac);
    if (this.closing) ac.abort();
    const renew = setInterval(() => {
      this.d.quota
        .renew(orgId, jobId, ORG_QUOTA_LEASE_MS)
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
      await this.runCase(data, ac.signal);
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
        .leave(orgId, jobId)
        .catch((err) => this.d.log.warn("eval quota leave failed", { jobId, err }));
    }
    await this.finishCase(runId);
  }

  /** 回放一个用例的全部未结束结果（按调用顺序）。 */
  private async runCase(data: EvalJobData, signal: AbortSignal): Promise<void> {
    const { runId, caseId } = data;
    const db = this.d.db;
    const [row, run] = await Promise.all([
      db.selectFrom("eval_cases").select("snapshot").where("id", "=", caseId).executeTakeFirst(),
      db.selectFrom("eval_runs").select("candidate").where("id", "=", runId).executeTakeFirst(),
    ]);
    if (!row || !run) return;
    const s = row.snapshot as CaseSnapshot;
    const candidate = run.candidate as EvalCandidate;
    const pending = await db
      .selectFrom("eval_results")
      .select(["id", "model_call_seq"])
      .where("run_id", "=", runId)
      .where("case_id", "=", caseId)
      .where("status", "in", [...UNFINISHED])
      .orderBy("model_call_seq")
      .execute();
    if (pending.length === 0) return;

    const base = await caseBase(db, s);
    if (!base) {
      await this.failResults(
        pending.map((p) => p.id),
        { code: "eval.definition_missing", message: "The agent version of this case is missing" },
      );
      return;
    }
    const resolved = resolveCandidate(
      base,
      candidate,
      await versionDefinition(db, s.agentId, candidate.agentVersion),
    );
    const calls = new Map(replayableCalls(s).map((c) => [c.seq, c]));

    for (const r of pending) {
      if (signal.aborted) throw new Aborted();
      if (!(await runActive(db, runId))) {
        await this.skipCase(data);
        return;
      }
      const claimed = await db
        .updateTable("eval_results")
        .set({ status: "running", updated_at: sql`now()` })
        .where("id", "=", r.id)
        .where("status", "in", [...UNFINISHED])
        .returning("id")
        .executeTakeFirst();
      if (!claimed) continue;
      const call = calls.get(Number(r.model_call_seq));
      if (!call) {
        await this.failResults([r.id], {
          code: "eval.call_not_found",
          message: "The model call is not replayable in this snapshot",
        });
        continue;
      }

      let out: Awaited<ReturnType<typeof replayStep>> | undefined;
      for (let attempt = 0; ; attempt++) {
        // 第一次请求前刚查过；重试前再查（取消 / 越限后不再发）
        if (attempt > 0 && !(await runActive(db, runId))) {
          await this.skipCase(data);
          return;
        }
        try {
          out = await replayStep(this.d.replay, s, call, resolved, signal);
          break;
        } catch (err) {
          if (signal.aborted) throw new Aborted();
          const f = classify(err);
          if (!f.retryable || attempt >= EVAL_MAX_RETRIES) {
            await this.failResults([r.id], { code: f.code, message: f.message });
            break;
          }
          const wait = Math.min(
            f.retryAfterMs ?? RETRY_DELAYS_MS[attempt] ?? 4000,
            MAX_RETRY_AFTER_MS,
          );
          await sleep(wait, signal);
        }
      }
      if (!out) continue;
      const result = out;
      const capped = await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("eval_results")
          .set({
            status: "done",
            baseline: JSON.stringify(result.baseline),
            candidate: JSON.stringify(result.candidate),
            drift: result.drift,
            error: null,
            updated_at: sql`now()`,
          })
          .where("id", "=", r.id)
          .execute();
        return (await consumeTokens(trx, runId, usageTokens(result.candidate.usage))).capped;
      });
      if (capped) {
        await this.skipCase(data);
        return;
      }
    }
  }

  private async failResults(ids: string[], error: { code: string; message: string }) {
    if (ids.length === 0) return;
    await this.d.db
      .updateTable("eval_results")
      .set({ status: "error", error: JSON.stringify(error), updated_at: sql`now()` })
      .where("id", "in", ids)
      .where("status", "in", [...UNFINISHED])
      .execute();
  }

  /** 该用例剩下的结果标 skipped。 */
  private async skipCase(data: EvalJobData): Promise<void> {
    await this.d.db
      .updateTable("eval_results")
      .set({ status: "skipped", updated_at: sql`now()` })
      .where("run_id", "=", data.runId)
      .where("case_id", "=", data.caseId)
      .where("status", "in", [...UNFINISHED])
      .execute();
  }

  /** BullMQ 判定任务失败（stalled 次数超限或处理函数抛错）：剩下的结果记 error，再重算进度。 */
  private async failCase(data: EvalJobData, err: Error): Promise<void> {
    const stalled = /stalled/i.test(err.message);
    await this.d.db
      .updateTable("eval_results")
      .set({
        status: "error",
        error: JSON.stringify(
          stalled
            ? { code: "eval.stalled", message: "The replay was interrupted too many times" }
            : { code: "eval.internal", message: "The replay failed unexpectedly" },
        ),
        updated_at: sql`now()`,
      })
      .where("run_id", "=", data.runId)
      .where("case_id", "=", data.caseId)
      .where("status", "in", [...UNFINISHED])
      .execute();
    await this.finishCase(data.runId);
  }

  /**
   * 重算 `cases_done` = 结果全部结束的用例数（幂等：任务重做不会重复计数），达到 `cases_total` 且运行仍在执行 →
   * `completed`。先锁运行行再数（READ COMMITTED 下新语句看得到其他任务已提交的结果），并发完成的任务不会互相覆盖。
   */
  private async finishCase(runId: string): Promise<void> {
    await this.d.db.transaction().execute(async (trx) => {
      const run = await trx
        .selectFrom("eval_runs")
        .select(["cases_total", "status"])
        .where("id", "=", runId)
        .forUpdate()
        .executeTakeFirst();
      if (!run) return;
      const r = await sql<{ n: string }>`
        SELECT count(*) AS n FROM (
          SELECT case_id FROM capybara.eval_results WHERE run_id = ${runId}
          GROUP BY case_id HAVING bool_and(status IN ('done', 'error', 'skipped'))
        ) finished`.execute(trx);
      const done = Number(r.rows[0]?.n ?? 0);
      const complete = done >= run.cases_total && ["queued", "running"].includes(run.status);
      await trx
        .updateTable("eval_runs")
        .set({
          cases_done: done,
          ...(complete && { status: "completed" as const, finished_at: sql`now()` }),
        })
        .where("id", "=", runId)
        .execute();
    });
  }
}
