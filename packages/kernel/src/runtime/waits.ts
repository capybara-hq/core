import type { Logger } from "@capybara-hq/plugin-sdk";
import { DelayedError, type Job } from "bullmq";
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
import type { RunAbortBy, RunAbortDetail } from "./abort.js";
import type { KyselyCheckpointSaver } from "./checkpointer.js";
import { subagentsWaitId, type WaitingFor } from "./loop.js";
import { MAINTENANCE_QUEUE_NAME, type Maintenance } from "./maintenance.js";
import { assistantIdemKey } from "./model-call.js";
import { finishRunIn } from "./run-finish.js";
import { ACTIVE_RUN_STATUSES, type RunQueue } from "./run-queue.js";

type KernelTrx = Transaction<KernelDatabase>;

/** 等待超时任务所在的内核维护队列（见 maintenance.ts）。 */
export { MAINTENANCE_QUEUE_NAME };

/** 等待超时任务的名字与 jobId（每个审批 / 输入请求一个，重复投递被 BullMQ 忽略）。 */
export const WAIT_TIMEOUT_JOB = "wait-timeout";
export const waitTimeoutJobId = (waitId: string): string => `wait-timeout-${waitId}`;

/** 续跑任务的 jobId：与按消息生成的 `run-<conversationId>-<seq>` 不冲突，同一等待只会续跑一次。 */
export const resumeJobId = (conversationId: string, waitId: string): string =>
  `run-${conversationId}-resume-${waitId}`;

/**
 * 等待兜底扫描（Task 22）：任务名、job scheduler id（不含 `:`）、周期、宽限期与每类每次最多处理的条数。
 * 宽限期：waiting 超过它、等待却已全部处理的运行才视为「续跑丢失」，避免与正常续跑（暂停后的复查等）竞争。
 */
export const WAIT_SWEEP_JOB = "wait-sweep";
export const WAIT_SWEEP_SCHEDULER_ID = "wait-sweep-every-10m";
export const WAIT_SWEEP_EVERY_MS = 600_000;
export const WAIT_SWEEP_GRACE_MS = 60_000;
export const WAIT_SWEEP_BATCH = 500;

/** 一次扫描（本副本）实际生效的修复数。 */
export interface WaitSweepResult {
  /** 过期仍 pending、被本次扫描按超时处理的审批 / 输入请求。 */
  expired: number;
  /** 等待已全部处理、被本次扫描续跑的 waiting 运行。 */
  resumed: number;
  /** 运行已终态、被本次扫描取消的审批 / 输入请求。 */
  cancelled: number;
  /** Queued sub-agent runs whose job was lost, enqueued again. */
  requeued: number;
  /** Running sub-agent runs without job or lock, failed `run.orphaned` and reported to the parent. */
  orphaned: number;
  /** Active sub-agent runs of a finished parent run, asked to stop. */
  stopped: number;
}

const TERMINAL_RUN_STATUSES = ["completed", "failed", "aborted"] as const;

/** The data of a wait timeout job; `subagents` waits also carry their run and step. */
export interface WaitTimeoutData {
  kind: WaitingFor["kind"];
  id: string;
  runId?: string;
  step?: number;
}

/** 超时任务处理出错（如 PG 暂不可用）时的重试。 */
const TIMEOUT_JOB_ATTEMPTS = 5;
const TIMEOUT_JOB_BACKOFF_MS = 5_000;

export interface WaitsDeps {
  db: KernelDb;
  eventLog: EventLog;
  approvals: Pick<ApprovalsService, "expire" | "cancelPendingIn">;
  questions: Pick<QuestionsService, "expire" | "cancelPendingIn">;
  runQueue: Pick<RunQueue, "enqueue" | "repairOrphan">;
  /**
   * Sub-agents (spec §7.5, §12): `stop` stops a parent run's active children (only those of `step`
   * when given, with `detail` on their `run_aborted`; `stopChildren`), `finished` reports a finished child to its parent
   * (`onChildFinished`). Wired by the kernel; without it the sweep skips sub-agent repairs.
   */
  subagents?: {
    stop: (
      parentRunId: string,
      byAccountId: string | null,
      opts?: { step?: number; detail?: RunAbortDetail },
    ) => Promise<number>;
    finished: (childRunId: string) => Promise<void>;
  };
  /** 等待中被中止的运行删除其 checkpoint thread。 */
  checkpoints?: Pick<KyselyCheckpointSaver, "deleteThread">;
  /**
   * Reads the run's stop marker (`RunAbort.requested`): between suspending and becoming `waiting`
   * the run has no subscriber, so a stop arriving then only sits in the marker; checked once after
   * `waiting` is set.
   */
  abortRequested?: (runId: string) => Promise<RunAbortBy | null>;
  /** 内核维护队列：超时任务投递到这里，处理函数在构造时登记（Worker 由它在 worker 角色上启动）。 */
  maintenance: Pick<Maintenance, "add" | "handle" | "schedule">;
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
  constructor(private readonly d: WaitsDeps) {
    d.maintenance.handle(WAIT_TIMEOUT_JOB, (job, token) =>
      this.process(job as Job<WaitTimeoutData>, token),
    );
    d.maintenance.schedule({
      id: WAIT_SWEEP_SCHEDULER_ID,
      name: WAIT_SWEEP_JOB,
      everyMs: () => WAIT_SWEEP_EVERY_MS,
    });
    d.maintenance.handle(WAIT_SWEEP_JOB, async () => {
      await this.sweep();
    });
  }

  /**
   * 兜底扫描（维护队列每 10 分钟一次，防延迟任务 / 续跑丢失）。每项修复都复用常规路径，与并发的超时任务、
   * 人工决定、其他副本的扫描竞争时由行锁与条件更新保证只生效一次；每项生效的修复记一行 warn（只含 id）。
   * 顺序：先取消终态运行的等待（这些不该再按超时处理），再处理过期的等待，最后续跑「续跑丢失」的运行。
   * 单项失败只记日志，不影响其他项。
   */
  async sweep(): Promise<WaitSweepResult> {
    const out: WaitSweepResult = {
      expired: 0,
      resumed: 0,
      cancelled: 0,
      requeued: 0,
      orphaned: 0,
      stopped: 0,
    };
    out.cancelled = await this.sweepFinishedRuns();
    out.expired = await this.sweepOverdue();
    Object.assign(out, await this.sweepSubagentOrphans());
    out.stopped = await this.sweepChildrenOfFinished();
    out.resumed = await this.sweepStuckRuns();
    return out;
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
    abort?: RunAbortBy,
  ): Promise<void> {
    const r = await this.d.db
      .updateTable("runs")
      .set({
        status: "waiting",
        waiting_since: sql<Date>`now()`,
        // a sub-agents wait has no row of its own: its expiry lives on the run, for the sweep
        wait_expires_at: waitingFor.kind === "subagents" ? new Date(waitingFor.expiresAt) : null,
      })
      .where("id", "=", runId)
      .where("status", "=", "running")
      .executeTakeFirst();
    if (Number(r.numUpdatedRows) === 0) {
      this.d.log.warn("run is no longer running; not suspending", { runId });
      return;
    }
    const stop = abort ?? (await this.d.abortRequested?.(runId)) ?? null;
    if (stop && (await this.abortWaiting(conversationId, runId, stop.byAccountId, stop.detail))) {
      return;
    }
    await this.scheduleTimeout(waitingFor, runId);
    if (await this.isSettled(waitingFor, runId)) await this.resume(runId, waitingFor.id);
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
        wait_expires_at: null,
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
      // sub-agents (spec §7.2): no child run of this run is still active, so a step waiting on
      // an approval and on sub-agents resumes once both are done, whichever finishes last
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("subagent_dispatches as sd")
              .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
              .select(sql`1`.as("one"))
              .where("sd.parent_run_id", "=", runId)
              .where("cr.status", "in", ACTIVE_RUN_STATUSES),
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
  async expire(
    kind: WaitingFor["kind"],
    id: string,
    at?: { runId: string; step: number },
  ): Promise<{ notDueUntil?: number }> {
    if (kind === "subagents") {
      // A safety net (spec §7.2, §12): the children of that step still active are stopped; each
      // stopped child reports to the parent, and the last one resumes it. The resume tried here
      // covers a step whose children were all done already.
      if (!at) {
        this.d.log.warn("sub-agent wait timeout without its run; ignored", { id });
        return {};
      }
      const { runId, step } = at;
      const stopped =
        (await this.d.subagents?.stop(runId, null, { step, detail: "wait_timeout" })) ?? 0;
      if (stopped > 0) {
        this.d.log.warn("sub-agent wait timed out; stopping its sub-agents", {
          runId,
          id,
          stopped,
        });
      }
      await this.resume(runId, id);
      return {};
    }
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
    detail?: RunAbortDetail,
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
        event: {
          type: "run_aborted",
          payload: { byAccountId, reason: "user", ...(detail !== undefined && { detail }) },
        },
      });
    });
    if (toSeq === null) return false;
    await this.d.eventLog.notify(conversationId, toSeq);
    await this.d.checkpoints
      ?.deleteThread(runId)
      .catch((err) => this.d.log.warn("checkpoint delete failed", { runId, err }));
    // a stopped sub-agent reports to its parent now, not at the next sweep (a no-op for other runs)
    await this.d.subagents
      ?.finished(runId)
      .catch((err) => this.d.log.error("cannot report stopped sub-agent run", { runId, err }));
    return true;
  }

  /** 扫描 3：运行已终态（如暂停途中失败）仍 pending 的审批 / 输入请求 → 取消（写决定 / 回答事件）。 */
  private async sweepFinishedRuns(): Promise<number> {
    const { db } = this.d;
    const runs = await db
      .selectFrom("runs")
      .select(["id", "conversation_id"])
      .where("status", "in", TERMINAL_RUN_STATUSES)
      .where(({ or, exists, selectFrom }) =>
        or([
          exists(
            selectFrom("approvals")
              .select(sql`1`.as("one"))
              .whereRef("approvals.run_id", "=", "runs.id")
              .where("approvals.status", "=", "pending"),
          ),
          exists(
            selectFrom("questions")
              .select(sql`1`.as("one"))
              .whereRef("questions.run_id", "=", "runs.id")
              .where("questions.status", "=", "pending"),
          ),
        ]),
      )
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    let total = 0;
    for (const run of runs) {
      try {
        const n = await this.cancelWaitsOfFinished(run.conversation_id, run.id);
        if (n > 0) {
          total += n;
          this.d.log.warn("wait sweep: cancelled waits of finished run", {
            runId: run.id,
            conversationId: run.conversation_id,
            count: n,
          });
        }
      } catch (err) {
        this.d.log.error("wait sweep: cannot cancel waits of finished run", { runId: run.id, err });
      }
    }
    return total;
  }

  /**
   * 同一事务里锁会话行与运行行（与 {@link abortWaiting} 同序），运行仍是终态时取消其 pending 等待；
   * 提交后发布事件。返回取消的条数（并发的另一副本拿到锁时已无 pending → 0）。
   */
  private async cancelWaitsOfFinished(conversationId: string, runId: string): Promise<number> {
    const r = await this.d.db.transaction().execute(async (t) => {
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
        .forUpdate()
        .executeTakeFirst();
      if (!run || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return 0;
      const a = await this.d.approvals.cancelPendingIn(t, runId);
      const q = await this.d.questions.cancelPendingIn(t, runId);
      return a.length + q.length;
    });
    if (r > 0) {
      const last = await this.d.db
        .selectFrom("conversation_events")
        .select(sql<string>`max(seq)`.as("seq"))
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      if (last?.seq != null) await this.d.eventLog.notify(conversationId, Number(last.seq));
    }
    return r;
  }

  /** 扫描 1：`expires_at < now()` 仍 pending 的审批 / 输入请求 → 与超时任务同一路径（置 expired、写事件、续跑）。 */
  private async sweepOverdue(): Promise<number> {
    const { db } = this.d;
    const approvals = await db
      .selectFrom("approvals")
      .select(["id", "run_id"])
      .where("status", "=", "pending")
      .where("expires_at", "<", sql<Date>`now()`)
      .orderBy("expires_at")
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    const questions = await db
      .selectFrom("questions")
      .select(["id", "run_id"])
      .where("status", "=", "pending")
      .where("expires_at", "<", sql<Date>`now()`)
      .orderBy("expires_at")
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    const due: { kind: WaitingFor["kind"]; id: string; runId: string }[] = [
      ...approvals.map((a) => ({ kind: "approval" as const, id: a.id, runId: a.run_id })),
      ...questions.map((q) => ({ kind: "input" as const, id: q.id, runId: q.run_id })),
    ];
    let total = 0;
    for (const w of due) {
      try {
        const r =
          w.kind === "approval"
            ? await this.d.approvals.expire(w.id)
            : await this.d.questions.expire(w.id);
        if (r.outcome !== "expired") continue;
        total++;
        this.d.log.warn("wait sweep: expired overdue wait", {
          kind: w.kind,
          id: w.id,
          runId: w.runId,
        });
        if (r.record) await this.resume(r.record.runId, w.id);
      } catch (err) {
        this.d.log.error("wait sweep: cannot expire overdue wait", { kind: w.kind, id: w.id, err });
      }
    }
    return total + (await this.sweepOverdueSubagents());
  }

  /**
   * Sub-agents waits past their `runs.wait_expires_at` (their timeout job was lost): expired the
   * way the timeout job would ({@link expire}: the step's active children stop as `timed out`, the
   * parent resumes once they are done). The step is the run's latest dispatch step: a waiting run
   * has active children only from the step it waits in.
   */
  private async sweepOverdueSubagents(): Promise<number> {
    if (!this.d.subagents) return 0;
    const runs = await this.d.db
      .selectFrom("runs")
      .select(["id"])
      .where("status", "=", "waiting")
      .where("wait_expires_at", "<", sql<Date>`now()`)
      .orderBy("wait_expires_at")
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    let total = 0;
    for (const r of runs) {
      try {
        const last = await this.d.db
          .selectFrom("subagent_dispatches")
          .select(sql<number | null>`max(step)`.as("step"))
          .where("parent_run_id", "=", r.id)
          .executeTakeFirst();
        if (last?.step == null) continue;
        const step = Number(last.step);
        const id = subagentsWaitId(r.id, step);
        this.d.log.warn("wait sweep: expired overdue wait", { kind: "subagents", id, runId: r.id });
        await this.expire("subagents", id, { runId: r.id, step });
        total++;
      } catch (err) {
        this.d.log.error("wait sweep: cannot expire overdue wait", {
          kind: "subagents",
          runId: r.id,
          err,
        });
      }
    }
    return total;
  }

  /**
   * Sub-agent runs nobody will run (spec §7.5; `RunQueue.repairOrphan`, the same orphan test as
   * `ensureRun`, which never runs for a child): `queued` past the grace period without a job → enqueued
   * again (the dispatch committed, its enqueue was lost); `running` without job and lock → failed
   * `run.orphaned` and reported to the parent, which then resumes.
   */
  private async sweepSubagentOrphans(): Promise<{ requeued: number; orphaned: number }> {
    const out = { requeued: 0, orphaned: 0 };
    const sub = this.d.subagents;
    if (!sub) return out;
    const runs = await this.d.db
      .selectFrom("runs")
      .innerJoin("conversations as c", "c.id", "runs.conversation_id")
      .select(["runs.id", "runs.conversation_id"])
      .where("c.kind", "=", "subagent")
      .where("runs.status", "in", ["queued", "running"])
      .where(
        sql<Date>`COALESCE(runs.queued_at, runs.created_at)`,
        "<",
        sql<Date>`now() - ${WAIT_SWEEP_GRACE_MS}::integer * interval '1 millisecond'`,
      )
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    for (const run of runs) {
      try {
        const r = await this.d.runQueue.repairOrphan(run.conversation_id, run.id);
        if (r === null) continue;
        if (r === "failed") {
          out.orphaned++;
          await sub.finished(run.id);
        } else out.requeued++;
        this.d.log.warn("wait sweep: repaired orphaned sub-agent run", {
          runId: run.id,
          conversationId: run.conversation_id,
          outcome: r,
        });
      } catch (err) {
        this.d.log.error("wait sweep: cannot repair orphaned sub-agent run", {
          runId: run.id,
          err,
        });
      }
    }
    return out;
  }

  /**
   * Active sub-agent runs of a parent run that finished more than the grace period ago (spec §7.5,
   * §12: a parent's terminal state stops its children; this is the backstop) → stopped.
   */
  private async sweepChildrenOfFinished(): Promise<number> {
    const sub = this.d.subagents;
    if (!sub) return 0;
    const parents = await this.d.db
      .selectFrom("subagent_dispatches as sd")
      .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
      .innerJoin("runs as pr", "pr.id", "sd.parent_run_id")
      .select("sd.parent_run_id")
      .distinct()
      .where("cr.status", "in", ACTIVE_RUN_STATUSES)
      .where("pr.status", "in", TERMINAL_RUN_STATUSES)
      .where(
        "pr.finished_at",
        "<",
        sql<Date>`now() - ${WAIT_SWEEP_GRACE_MS}::integer * interval '1 millisecond'`,
      )
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    let total = 0;
    for (const p of parents) {
      try {
        const n = await sub.stop(p.parent_run_id, null);
        if (n === 0) continue;
        total += n;
        this.d.log.warn("wait sweep: stopped sub-agents of a finished run", {
          runId: p.parent_run_id,
          count: n,
        });
      } catch (err) {
        this.d.log.error("wait sweep: cannot stop sub-agents of a finished run", {
          runId: p.parent_run_id,
          err,
        });
      }
    }
    return total;
  }

  /**
   * 扫描 2：waiting 超过宽限期、却已没有 pending 等待的运行（决定提交后进程崩溃、续跑投递失败回滚等）→
   * {@link resume}（条件更新 `waiting → queued` + 投递）。续跑任务的 jobId 用该运行最近一次等待的 id
   * （与人工决定 / 超时任务一致，已投递过的同一续跑被 BullMQ 去重）。
   */
  private async sweepStuckRuns(): Promise<number> {
    const runs = await this.d.db
      .selectFrom("runs")
      .select(["id", "conversation_id"])
      .where("status", "=", "waiting")
      .where(
        "waiting_since",
        "<",
        sql<Date>`now() - ${WAIT_SWEEP_GRACE_MS}::integer * interval '1 millisecond'`,
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("approvals")
              .select(sql`1`.as("one"))
              .whereRef("approvals.run_id", "=", "runs.id")
              .where("approvals.status", "=", "pending"),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("questions")
              .select(sql`1`.as("one"))
              .whereRef("questions.run_id", "=", "runs.id")
              .where("questions.status", "=", "pending"),
          ),
        ),
      )
      // the resume condition's third clause: a parent with an active child is not stuck
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("subagent_dispatches as sd")
              .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
              .select(sql`1`.as("one"))
              .whereRef("sd.parent_run_id", "=", "runs.id")
              .where("cr.status", "in", ACTIVE_RUN_STATUSES),
          ),
        ),
      )
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    let total = 0;
    for (const run of runs) {
      try {
        const waitId = (await this.lastWaitId(run.id)) ?? run.id;
        if (!(await this.resume(run.id, waitId))) continue;
        total++;
        this.d.log.warn("wait sweep: resumed stuck waiting run", {
          runId: run.id,
          conversationId: run.conversation_id,
          waitId,
        });
      } catch (err) {
        this.d.log.error("wait sweep: cannot resume stuck waiting run", { runId: run.id, err });
      }
    }
    return total;
  }

  /**
   * The id of the run's latest wait (by creation time): an approval, an input request or a
   * sub-agent dispatch, whose wait id is its child run id (the id the child's finisher resumes
   * with, so a sweep resume and a late finisher resume share one job id).
   */
  private async lastWaitId(runId: string): Promise<string | null> {
    const row = await this.d.db
      .selectFrom(
        this.d.db
          .selectFrom("approvals")
          .select(["id", "created_at"])
          .where("run_id", "=", runId)
          .unionAll(
            this.d.db
              .selectFrom("questions")
              .select(["id", "created_at"])
              .where("run_id", "=", runId),
          )
          .unionAll(
            this.d.db
              .selectFrom("subagent_dispatches")
              .select(["child_run_id as id", "created_at"])
              .where("parent_run_id", "=", runId),
          )
          .as("w"),
      )
      .select("w.id")
      .orderBy("w.created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async process(job: Job<WaitTimeoutData>, token: string | undefined): Promise<void> {
    const { kind, id, runId, step } = job.data;
    const at = runId !== undefined && step !== undefined ? { runId, step } : undefined;
    const r = await this.expire(kind, id, at);
    if (r.notDueUntil !== undefined) {
      await job.moveToDelayed(r.notDueUntil, token);
      throw new DelayedError();
    }
  }

  /** 投递超时任务（延迟到 expiresAt）。失败只记日志：人工处理仍可续跑，只是不会自动超时。 */
  private async scheduleTimeout(w: WaitingFor, runId: string): Promise<void> {
    const data: WaitTimeoutData =
      w.kind === "subagents" && w.step !== undefined
        ? { kind: w.kind, id: w.id, runId, step: w.step }
        : { kind: w.kind, id: w.id };
    try {
      await this.d.maintenance.add(WAIT_TIMEOUT_JOB, data, {
        jobId: waitTimeoutJobId(w.id),
        delay: Math.max(0, new Date(w.expiresAt).getTime() - Date.now()),
        attempts: TIMEOUT_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: TIMEOUT_JOB_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (err) {
      this.d.log.error("cannot schedule wait timeout", { waitId: w.id, err });
    }
  }

  /**
   * Whether the wait is over: an approval or input request is no longer pending (decided, expired
   * or cancelled); `subagents`: no child run of the run is active.
   */
  private async isSettled(w: WaitingFor, runId: string): Promise<boolean> {
    if (w.kind === "subagents") {
      const active = await this.d.db
        .selectFrom("subagent_dispatches as sd")
        .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
        .select("cr.id")
        .where("sd.parent_run_id", "=", runId)
        .where("cr.status", "in", ACTIVE_RUN_STATUSES)
        .executeTakeFirst();
      return active === undefined;
    }
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
