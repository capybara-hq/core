import type { Logger } from "@capybara-hq/plugin-sdk";
import { DelayedError, type Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import {
  APPROVAL_CANCELLED_TEXT,
  INPUT_CANCELLED_TEXT,
  RUN_STOPPED_TEXT,
} from "../tools/pipeline.js";
import type { QuestionsService } from "../tools/questions.service.js";
import type { KyselyCheckpointSaver } from "./checkpointer.js";
import type { WaitingFor } from "./loop.js";
import { assistantIdemKey } from "./model-call.js";
import { finishRunIn } from "./run-finish.js";
import { bullConnection, type RunQueue } from "./run-queue.js";

type KernelTrx = Transaction<KernelDatabase>;

/**
 * 内核维护队列（不含 `:`）：目前只有等待超时任务（`wait-timeout`）；Task 10 的周期性维护也放这里。
 * 与运行队列分开：运行 worker 的处理函数、stalled / 失败处理都按「一个任务 = 一次运行」设计，混入别的任务类型
 * 会让这些路径都要分支；维护任务短、无会话锁与配额，单独一个 Worker 更直接。
 */
export const MAINTENANCE_QUEUE_NAME = "cap-kernel-maintenance";

/** 等待超时任务的名字与 jobId（每个审批 / 输入请求一个，重复投递被 BullMQ 忽略）。 */
export const WAIT_TIMEOUT_JOB = "wait-timeout";
export const waitTimeoutJobId = (waitId: string): string => `wait-timeout-${waitId}`;

/** 续跑任务的 jobId：与按消息生成的 `run-<conversationId>-<seq>` 不冲突，同一等待只会续跑一次。 */
export const resumeJobId = (conversationId: string, waitId: string): string =>
  `run-${conversationId}-resume-${waitId}`;

/** 等待超时任务的数据。 */
export interface WaitTimeoutData {
  kind: WaitingFor["kind"];
  id: string;
}

/** 超时任务处理出错（如 PG 暂不可用）时的重试。 */
const TIMEOUT_JOB_ATTEMPTS = 5;
const TIMEOUT_JOB_BACKOFF_MS = 5_000;

export interface WaitsDeps {
  db: KernelDb;
  eventLog: EventLog;
  approvals: Pick<ApprovalsService, "expire" | "cancelPendingIn">;
  questions: Pick<QuestionsService, "expire" | "cancelPendingIn">;
  runQueue: Pick<RunQueue, "enqueue">;
  /** 等待中被中止的运行删除其 checkpoint thread。 */
  checkpoints?: Pick<KyselyCheckpointSaver, "deleteThread">;
  /**
   * 读该运行的中止标记（`RunAbort.requested`）：暂停到置 waiting 之间没有订阅者，期间到达的中止只留在标记里，
   * 置 waiting 之后补查一次。
   */
  abortRequested?: (runId: string) => Promise<{ byAccountId: string | null } | null>;
  redisUrl: string;
  log: Pick<Logger, "error" | "warn">;
}

/**
 * 运行等待人处理（spec 4.4 / Task 9）：暂停、续跑、超时与中止。状态全部在 PG（`runs.status = 'waiting'`、
 * `approvals` / `questions` 行），延迟与重试走 BullMQ（维护队列的 `wait-timeout` 任务），没有进程内状态。
 *
 * 只续跑一次：`resume` 是一条条件更新 `waiting → queued`（且该运行已没有 pending 的等待），并发调用只有一个成功，
 * 成功者投递 jobId 为 `run-<conversationId>-resume-<waitId>` 的运行任务。人工决定、超时任务、
 * 暂停后的复查都可能调用它，谁先谁后都只有一次续跑。
 */
export class Waits {
  private queue: Queue<WaitTimeoutData> | undefined;
  private queueConn: Redis | undefined;
  private worker: Worker<WaitTimeoutData> | undefined;
  private workerConn: Redis | undefined;
  private closed = false;

  constructor(private readonly d: WaitsDeps) {}

  private getQueue(): Queue<WaitTimeoutData> {
    if (this.closed) throw new Error("waits are closed");
    if (!this.queue) {
      this.queueConn = bullConnection(this.d.redisUrl, this.d.log);
      this.queue = new Queue<WaitTimeoutData>(MAINTENANCE_QUEUE_NAME, {
        connection: this.queueConn,
      });
      this.queue.on("error", (err) => this.d.log.error("maintenance queue error", { err }));
    }
    return this.queue;
  }

  /**
   * loop 返回 `suspended` 之后（worker 已释放会话锁与配额）：条件更新 `running → waiting`（记 `waiting_since`），
   * 投递延迟到 `expiresAt` 的超时任务，再复查一次等待是否已被处理——处理者的 `resume` 可能发生在本次置 waiting
   * 之前（那时条件更新不成立），复查保证这种情况下仍会续跑。
   * 运行已不是 running（例如已被其他路径结束）→ 什么都不做。
   * 暂停时已收到用户中止（`abort`），或置 waiting 之后补查到中止标记 → 直接按 {@link abortWaiting} 取消等待并结束
   * 运行（置 waiting 之后到达的中止由 `POST .../abort` 看到 waiting 直接处理，两边不会都漏掉）。
   */
  async suspend(
    runId: string,
    conversationId: string,
    waitingFor: WaitingFor,
    abort?: { byAccountId: string | null },
  ): Promise<void> {
    const r = await this.d.db
      .updateTable("runs")
      .set({ status: "waiting", waiting_since: sql<Date>`now()` })
      .where("id", "=", runId)
      .where("status", "=", "running")
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) {
      this.d.log.warn("run is no longer running; not suspending", { runId });
      return;
    }
    const stop = abort ?? (await this.d.abortRequested?.(runId)) ?? null;
    if (stop && (await this.abortWaiting(conversationId, runId, stop.byAccountId))) return;
    await this.scheduleTimeout(waitingFor);
    if (await this.isSettled(waitingFor)) await this.resume(runId, waitingFor.id);
  }

  /**
   * 续跑：一条条件更新 `waiting → queued`（且该运行没有 pending 的审批 / 输入请求），把本次等待时长累加进
   * `waited_ms`，记下续跑任务的 jobId；成功（只有一个调用方）则投递运行任务并返回 true。
   * 投递失败 → 撤回为 waiting（等待时长已计入，重新从现在起计），之后超时任务到点会再次续跑，并抛出。
   */
  async resume(runId: string, waitId: string): Promise<boolean> {
    const row = await this.d.db
      .updateTable("runs")
      .set({
        status: "queued",
        queued_at: sql<Date>`now()`,
        job_id: sql<string>`'run-' || conversation_id || '-resume-' || ${waitId}::text`,
        waited_ms: sql<string>`waited_ms + COALESCE(floor(extract(epoch FROM now() - waiting_since) * 1000), 0)::bigint`,
        waiting_since: null,
      })
      .where("id", "=", runId)
      .where("status", "=", "waiting")
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("approvals")
              .select(sql`1`.as("one"))
              .where("approvals.run_id", "=", runId)
              .where("approvals.status", "=", "pending"),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("questions")
              .select(sql`1`.as("one"))
              .where("questions.run_id", "=", runId)
              .where("questions.status", "=", "pending"),
          ),
        ),
      )
      .returning(["conversation_id"])
      .executeTakeFirst();
    if (!row) return false;
    const jobId = resumeJobId(row.conversation_id, waitId);
    try {
      await this.d.runQueue.enqueue({ runId, conversationId: row.conversation_id }, jobId);
    } catch (err) {
      this.d.log.error("cannot enqueue resumed run; back to waiting", { runId, jobId, err });
      await this.d.db
        .updateTable("runs")
        .set({ status: "waiting", waiting_since: sql<Date>`now()`, job_id: null, queued_at: null })
        .where("id", "=", runId)
        .where("status", "=", "queued")
        .where("job_id", "=", jobId)
        .execute();
      throw err;
    }
    return true;
  }

  /**
   * 超时（`wait-timeout` 任务）：仍 pending 且已到期 → 置 expired 并写决定 / 回答事件；随后（无论本次是否生效）
   * 尝试续跑——若人工决定之后的续跑没能发生（进程崩溃、投递失败），超时任务兜底。
   * 尚未到期（任务被提前执行）→ 返回到期时间，由任务重新延迟。
   */
  async expire(kind: WaitingFor["kind"], id: string): Promise<{ notDueUntil?: number }> {
    const r =
      kind === "approval" ? await this.d.approvals.expire(id) : await this.d.questions.expire(id);
    if (r.outcome === "not_due" && r.record) {
      return { notDueUntil: new Date(r.record.expiresAt).getTime() };
    }
    if (r.record) await this.resume(r.record.runId, id);
    return {};
  }

  /**
   * 中止等待中的运行（`POST .../abort`）：同一事务里锁会话行与运行行，运行仍是 waiting 时——取消它的 pending 审批 /
   * 输入请求（写 `approval_decided{cancelled}` / `question_answered{cancelled}`），给等待中的调用写取消说明的
   * `tool_result`（同一步里尚未执行的调用写「未执行」），再写 `run_aborted` 终态；提交后删除 checkpoint。
   * 运行已不是 waiting（例如刚被续跑）→ 返回 false，由调用方走常规中止。
   */
  async abortWaiting(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
  ): Promise<boolean> {
    const toSeq = await this.d.db.transaction().execute(async (t) => {
      await t
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", conversationId)
        .forUpdate()
        .executeTakeFirst();
      const run = await t
        .selectFrom("runs")
        .select("status")
        .where("id", "=", runId)
        .where("conversation_id", "=", conversationId)
        .forUpdate()
        .executeTakeFirst();
      if (run?.status !== "waiting") return null;
      await this.d.approvals.cancelPendingIn(t, runId);
      await this.d.questions.cancelPendingIn(t, runId);
      // 本运行全部审批 / 输入请求涉及的调用（不只刚取消的）：决定已提交、续跑尚未发生时被中止的调用同样没有结果，
      // 一并写取消说明（已有结果的按幂等键命中、不重复）。同一调用先审批后输入，后者覆盖前者。
      const cancelled = new Map<string, { toolKey: string; text: string }>();
      const steps = new Set<number>();
      const approvals = await t
        .selectFrom("approvals")
        .select(["id", "call_id", "tool_key"])
        .where("run_id", "=", runId)
        .orderBy("created_at")
        .execute();
      for (const a of approvals) {
        cancelled.set(a.call_id, { toolKey: a.tool_key, text: APPROVAL_CANCELLED_TEXT });
        const step = await this.approvalStep(t, conversationId, a.id);
        if (step !== null) steps.add(step);
      }
      const questions = await t
        .selectFrom("questions")
        .select(["call_id", "spec"])
        .where("run_id", "=", runId)
        .orderBy("created_at")
        .execute();
      for (const q of questions) {
        const spec = q.spec as { toolKey?: string; step?: number };
        cancelled.set(q.call_id, { toolKey: spec.toolKey ?? "", text: INPUT_CANCELLED_TEXT });
        if (typeof spec.step === "number") steps.add(spec.step);
      }
      const results = await this.stoppedResults(t, conversationId, runId, [...steps], cancelled);
      if (results.length > 0) await this.d.eventLog.append(conversationId, results, t);
      return finishRunIn(t, this.d.eventLog, {
        conversationId,
        runId,
        status: "aborted",
        consumed: null,
        event: { type: "run_aborted", payload: { byAccountId, reason: "user" } },
      });
    });
    if (toSeq === null) return false;
    await this.d.eventLog.notify(conversationId, toSeq);
    await this.d.checkpoints
      ?.deleteThread(runId)
      .catch((err) => this.d.log.warn("checkpoint delete failed", { runId, err }));
    return true;
  }

  /** 启动超时任务的 worker（只在含 `worker` 角色的进程）。 */
  startWorker(): void {
    if (this.worker || this.closed) return;
    this.workerConn = bullConnection(this.d.redisUrl, this.d.log);
    this.worker = new Worker<WaitTimeoutData>(
      MAINTENANCE_QUEUE_NAME,
      (job, token) => this.process(job, token),
      { connection: this.workerConn, concurrency: 5 },
    );
    this.worker.on("error", (err) => this.d.log.error("maintenance worker error", { err }));
    this.worker.on("failed", (job, err) =>
      this.d.log.error("maintenance job failed", { jobId: job?.id, err }),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    const q = this.queue;
    this.worker = undefined;
    this.queue = undefined;
    await w?.close().catch(() => {});
    await q?.close().catch(() => {});
    for (const c of [this.workerConn, this.queueConn]) {
      if (c) await c.quit().catch(() => c.disconnect());
    }
    this.workerConn = undefined;
    this.queueConn = undefined;
  }

  private async process(job: Job<WaitTimeoutData>, token: string | undefined): Promise<void> {
    if (job.name !== WAIT_TIMEOUT_JOB) {
      this.d.log.warn("unknown maintenance job", { name: job.name, jobId: job.id });
      return;
    }
    const r = await this.expire(job.data.kind, job.data.id);
    if (r.notDueUntil !== undefined) {
      await job.moveToDelayed(r.notDueUntil, token);
      throw new DelayedError();
    }
  }

  /** 投递超时任务（延迟到 expiresAt）。失败只记日志：人工处理仍可续跑，只是不会自动超时。 */
  private async scheduleTimeout(w: WaitingFor): Promise<void> {
    try {
      await this.getQueue().add(
        WAIT_TIMEOUT_JOB,
        { kind: w.kind, id: w.id },
        {
          jobId: waitTimeoutJobId(w.id),
          delay: Math.max(0, new Date(w.expiresAt).getTime() - Date.now()),
          attempts: TIMEOUT_JOB_ATTEMPTS,
          backoff: { type: "exponential", delay: TIMEOUT_JOB_BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    } catch (err) {
      this.d.log.error("cannot schedule wait timeout", { waitId: w.id, err });
    }
  }

  /** 等待对象已不再 pending（已处理 / 超时 / 取消）。 */
  private async isSettled(w: WaitingFor): Promise<boolean> {
    const row =
      w.kind === "approval"
        ? await this.d.db
            .selectFrom("approvals")
            .select("status")
            .where("id", "=", w.id)
            .executeTakeFirst()
        : await this.d.db
            .selectFrom("questions")
            .select("status")
            .where("id", "=", w.id)
            .executeTakeFirst();
    return row !== undefined && row.status !== "pending";
  }

  /** 审批所在的步（`approval_requested` 事件里记的）。 */
  private async approvalStep(
    t: KernelTrx,
    conversationId: string,
    approvalId: string,
  ): Promise<number | null> {
    const ev = await t
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", conversationId)
      .where("idem_key", "=", `approval_requested:${approvalId}`)
      .executeTakeFirst();
    const step = (ev?.payload as { step?: unknown } | undefined)?.step;
    return typeof step === "number" ? step : null;
  }

  /**
   * 等待中被中止的运行：这些步里每个调用都补一条 `tool_result`（已有结果的按幂等键命中、不重复），
   * 等待中的调用给取消说明，其余（排在等待调用之后、尚未执行的）给「未执行」说明。
   */
  private async stoppedResults(
    t: KernelTrx,
    conversationId: string,
    runId: string,
    steps: number[],
    cancelled: Map<string, { toolKey: string; text: string }>,
  ): Promise<AppendEvent[]> {
    const out: AppendEvent[] = [];
    for (const step of steps.sort((a, b) => a - b)) {
      const msg = await t
        .selectFrom("conversation_events")
        .select("payload")
        .where("conversation_id", "=", conversationId)
        .where("idem_key", "=", assistantIdemKey(runId, step))
        .executeTakeFirst();
      const content = (msg?.payload as { content?: unknown[] } | undefined)?.content ?? [];
      for (const b of content as { type: string; id?: string; name?: string }[]) {
        if (b.type !== "tool_call" || b.id === undefined) continue;
        const c = cancelled.get(b.id);
        out.push({
          type: "tool_result",
          runId,
          idemKey: `tool_result:${runId}:${b.id}`,
          payload: {
            step,
            callId: b.id,
            toolKey: c?.toolKey ?? b.name ?? "",
            content: c?.text ?? RUN_STOPPED_TEXT,
            isError: true,
          },
        });
      }
    }
    return out;
  }
}
