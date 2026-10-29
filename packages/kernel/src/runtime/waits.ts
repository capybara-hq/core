import type { Logger } from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { DelayedError, type Job, type Queue } from "bullmq";
import { sql } from "kysely";
import { type AppendEvent, EventLog } from "../conversations/event-log.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { ApprovalsService } from "../tools/approvals.service.js";
import {
  APPROVAL_CANCELLED_TEXT,
  INPUT_CANCELLED_TEXT,
  RUN_STOPPED_TEXT,
  ToolPipeline,
} from "../tools/pipeline.js";
import { QuestionsService } from "../tools/questions.service.js";
import { RunAbort, type RunAbortBy, type RunAbortDetail } from "./abort.js";
import { KyselyCheckpointSaver } from "./checkpointer.js";
import { subagentsWaitId, subagentWaitingIdemKey, type WaitingFor } from "./loop.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { assistantIdemKey } from "./model-call.js";
import { notifyFinished, RunFinish, TERMINAL_STATUSES } from "./run-finish.js";
import { ACTIVE_RUN_STATUSES, RunQueue } from "./run-queue.js";
import { childResult, dispatchOfChildRun, finishedEvent } from "./subagents/child.js";

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
/** The maintenance scheduler the sweep ran on before it became a `@LockedCron` (retired). */
export { WAIT_SWEEP_SCHEDULER_ID } from "./job-ids.js";
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
  /**
   * Finished parent runs whose open `agent` calls had no `tool_result`, repaired (final review
   * I3: the next run would send an unpaired tool call, which providers refuse).
   */
  repaired: number;
  /** Queued sub-agent runs, and chat runs queued by a resume, whose job was lost, enqueued again. */
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

/**
 * 运行等待人处理（spec 4.4 / Task 9）：暂停、续跑、超时与中止。状态全部在 PG（`runs.status = 'waiting'`、
 * `approvals` / `questions` 行），延迟与重试走 BullMQ（维护队列的 `wait-timeout` 任务），没有进程内状态。
 *
 * 只续跑一次：`resume` 是一条条件更新 `waiting → queued`（且该运行已没有 pending 的等待），并发调用只有一个成功，
 * 成功者投递 jobId 为 `run-<conversationId>-resume-<waitId>` 的运行任务。人工决定、超时任务、
 * 暂停后的复查都可能调用它，谁先谁后都只有一次续跑。
 */
@Injectable()
export class Waits implements OnModuleDestroy {
  /** Drops the `run.orphaned` subscription (the events may outlive this instance). */
  private readonly unsubscribe: () => void;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(ApprovalsService)
    private readonly approvals: Pick<ApprovalsService, "expire" | "cancelPendingIn">,
    @Inject(QuestionsService)
    private readonly questions: Pick<QuestionsService, "expire" | "cancelPendingIn">,
    @Inject(RunQueue)
    private readonly runQueue: Pick<RunQueue, "enqueue" | "repairOrphan" | "abortIfOrphaned">,
    /**
     * Writes, in the caller's transaction, the results of a stopped run's open `agent` calls;
     * `fire` runs their observe hooks after the commit.
     */
    @Inject(ToolPipeline) private readonly pipeline: Pick<ToolPipeline, "stopOpenAgentCalls">,
    @Inject(RunFinish) private readonly finisher: Pick<RunFinish, "finishIn">,
    /** 等待中被中止的运行删除其 checkpoint thread。 */
    @Inject(KyselyCheckpointSaver)
    private readonly checkpoints: Pick<KyselyCheckpointSaver, "deleteThread">,
    /**
     * The run's stop marker (`RunAbort.requested`): between suspending and becoming `waiting` the
     * run has no subscriber, so a stop arriving then only sits in the marker; checked once after
     * `waiting` is set. Children are stopped through `request`.
     */
    @Inject(RunAbort) private readonly abort: Pick<RunAbort, "requested" | "request">,
    /** The maintenance queue: wait timeout jobs (`MaintenanceProcessor` consumes them). */
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) private readonly timeouts: Pick<Queue, "add">,
    @Inject(KernelEvents) events: KernelEvents,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "error" | "warn">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {
    // an orphaned parent run (marked failed by `ensureRun`) stops its children at once; the
    // sweep's `sweepChildrenOfFinished` is the backstop
    this.unsubscribe = events.on("run.orphaned", ({ runId }) =>
      this.stopChildren(runId, null)
        .then(() => {})
        .catch((err) =>
          this.log.error("cannot stop the sub-agents of an orphaned run", { runId, err }),
        ),
    );
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  /** The context's handle (the transaction of a `@Transactional` method, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
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
      repaired: 0,
      requeued: 0,
      orphaned: 0,
      stopped: 0,
    };
    out.cancelled = await this.sweepFinishedRuns();
    out.expired = await this.sweepOverdue();
    Object.assign(out, await this.sweepSubagentOrphans());
    out.repaired = await this.sweepOpenAgentCalls();
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
    const r = await this.db
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
      this.log.warn("run is no longer running; not suspending", { runId });
      return;
    }
    const stop = abort ?? (await this.abort.requested(runId)) ?? null;
    if (stop && (await this.abortWaiting(conversationId, runId, stop.byAccountId, stop.detail))) {
      return;
    }
    await this.surfaceInParent(runId, waitingFor);
    await this.scheduleTimeout(waitingFor, runId);
    if (await this.isSettled(waitingFor, runId)) await this.resume(runId, waitingFor.id);
  }

  /**
   * A sub-agent's run waits for an approval or an input (sub-agents spec §9): appends
   * `subagent_waiting` to the parent conversation (idem `subagent_waiting:<childRunId>:<waitId>`),
   * so the web and the channel outbound show the card there. The approval or question itself stays
   * the child run's, with the parent run's starter as the person asked. Not a run of a sub-agent,
   * or a `subagents` wait: nothing. Display only: a failure is logged, the wait goes on.
   */
  private async surfaceInParent(runId: string, waitingFor: WaitingFor): Promise<void> {
    if (waitingFor.kind === "subagents") return;
    try {
      const d = await this.db
        .selectFrom("subagent_dispatches")
        .select(["parent_conversation_id", "parent_run_id", "child_conversation_id"])
        .where("child_run_id", "=", runId)
        .executeTakeFirst();
      if (!d) return;
      const row =
        waitingFor.kind === "approval"
          ? await this.db
              .selectFrom("approvals")
              .select(["tool_key", "expires_at"])
              .where("id", "=", waitingFor.id)
              .executeTakeFirst()
          : await this.db
              .selectFrom("questions")
              .select([sql<string>`spec->>'toolKey'`.as("tool_key"), "expires_at"])
              .where("id", "=", waitingFor.id)
              .executeTakeFirst();
      if (!row) return;
      await this.eventLog.append(d.parent_conversation_id, [
        {
          type: "subagent_waiting",
          runId: d.parent_run_id,
          idemKey: subagentWaitingIdemKey(runId, waitingFor.id),
          payload: {
            subagentId: d.child_conversation_id,
            childRunId: runId,
            kind: waitingFor.kind,
            ...(waitingFor.kind === "approval"
              ? { approvalId: waitingFor.id }
              : { questionId: waitingFor.id }),
            toolKey: row.tool_key,
            expiresAt: new Date(row.expires_at).toISOString(),
          },
        },
      ]);
    } catch (err) {
      this.log.error("cannot surface a sub-agent's wait in its parent", { runId, err });
    }
  }

  /**
   * 续跑：一条条件更新 `waiting → queued`（且该运行没有 pending 的审批 / 输入请求），把本次等待时长累加进
   * `waited_ms`，记下续跑任务的 jobId；成功（只有一个调用方）则投递运行任务并返回 true。
   * 投递失败 → 撤回为 waiting（等待时长已计入，重新从现在起计），之后超时任务到点会再次续跑，并抛出。
   */
  async resume(runId: string, waitId: string): Promise<boolean> {
    const row = await this.db
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
      await this.runQueue.enqueue({ runId, conversationId: row.conversation_id }, jobId);
    } catch (err) {
      this.log.error("cannot enqueue resumed run; back to waiting", { runId, jobId, err });
      await this.db
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
  ): Promise<{ notDueUntil?: number; acted?: boolean }> {
    if (kind === "subagents") {
      // A safety net (spec §7.2, §12): the children of that step still active are stopped; each
      // stopped child reports to the parent, and the last one resumes it. The resume tried here
      // covers a step whose children were all done already.
      if (!at) {
        this.log.warn("sub-agent wait timeout without its run; ignored", { id });
        return {};
      }
      const { runId, step } = at;
      const stopped = await this.stopChildren(runId, null, { step, detail: "wait_timeout" });
      if (stopped > 0) {
        this.log.warn("sub-agent wait timed out; stopping its sub-agents", {
          runId,
          id,
          stopped,
        });
      }
      const resumed = await this.resume(runId, id);
      return { acted: stopped > 0 || resumed };
    }
    const r =
      kind === "approval" ? await this.approvals.expire(id) : await this.questions.expire(id);
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
    const st: { stopped?: { fire: () => void } } = {};
    const toSeq = await this.abortWaitingIn(conversationId, runId, byAccountId, detail, st);
    const stopped = st.stopped;
    if (toSeq === null) return false;
    await notifyFinished(this.eventLog, conversationId, toSeq, "aborted");
    await this.checkpoints
      .deleteThread(runId)
      .catch((err) => this.log.warn("checkpoint delete failed", { runId, err }));
    stopped?.fire();
    // a stopped sub-agent reports to its parent now, not at the next sweep (a no-op for other runs)
    await this.childFinished(runId).catch((err) =>
      this.log.error("cannot report stopped sub-agent run", { runId, err }),
    );
    // a stopped parent stops its children (spec §12), on the parent's behalf (no account: they
    // report "stopped with this run"); the wait sweep is the backstop
    await this.stopChildren(runId, null).catch((err) =>
      this.log.error("cannot stop the sub-agents of a run", { runId, err }),
    );
    return true;
  }

  /** {@link abortWaiting}'s transaction; the open `agent` calls it wrote go back through `st`. */
  @Transactional({ propagation: "requires_new" })
  private async abortWaitingIn(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
    detail: RunAbortDetail | undefined,
    st: { stopped?: { fire: () => void } },
  ): Promise<number | null> {
    const t = this.db;
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
    await this.approvals.cancelPendingIn(runId);
    await this.questions.cancelPendingIn(runId);
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
    // a parent waiting on sub-agents (spec §12): its open `agent` calls get their results
    const agents = await this.pipeline.stopOpenAgentCalls(runId);
    for (const step of agents.steps) steps.add(step);
    const results = await this.stoppedResults(
      t,
      conversationId,
      runId,
      [...steps],
      cancelled,
      agents?.callIds,
    );
    if (results.length > 0) await this.eventLog.appendIn(conversationId, results);
    st.stopped = agents;
    return this.finisher.finishIn({
      conversationId,
      runId,
      status: "aborted",
      consumed: null,
      event: {
        type: "run_aborted",
        payload: { byAccountId, reason: "user", ...(detail !== undefined && { detail }) },
      },
    });
  }

  /** 扫描 3：运行已终态（如暂停途中失败）仍 pending 的审批 / 输入请求 → 取消（写决定 / 回答事件）。 */
  private async sweepFinishedRuns(): Promise<number> {
    const db = this.db;
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
          this.log.warn("wait sweep: cancelled waits of finished run", {
            runId: run.id,
            conversationId: run.conversation_id,
            count: n,
          });
        }
      } catch (err) {
        this.log.error("wait sweep: cannot cancel waits of finished run", { runId: run.id, err });
      }
    }
    return total;
  }

  /**
   * 同一事务里锁会话行与运行行（与 {@link abortWaiting} 同序），运行仍是终态时取消其 pending 等待；
   * 提交后发布事件。返回取消的条数（并发的另一副本拿到锁时已无 pending → 0）。
   */
  private async cancelWaitsOfFinished(conversationId: string, runId: string): Promise<number> {
    const r = await this.cancelWaitsOfFinishedIn(conversationId, runId);
    if (r > 0) {
      const last = await this.db
        .selectFrom("conversation_events")
        .select(sql<string>`max(seq)`.as("seq"))
        .where("conversation_id", "=", conversationId)
        .executeTakeFirst();
      if (last?.seq != null) await this.eventLog.notify(conversationId, Number(last.seq));
    }
    return r;
  }

  @Transactional({ propagation: "requires_new" })
  private async cancelWaitsOfFinishedIn(conversationId: string, runId: string): Promise<number> {
    const t = this.db;
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
    const a = await this.approvals.cancelPendingIn(runId);
    const q = await this.questions.cancelPendingIn(runId);
    return a.length + q.length;
  }

  /** 扫描 1：`expires_at < now()` 仍 pending 的审批 / 输入请求 → 与超时任务同一路径（置 expired、写事件、续跑）。 */
  private async sweepOverdue(): Promise<number> {
    const db = this.db;
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
            ? await this.approvals.expire(w.id)
            : await this.questions.expire(w.id);
        if (r.outcome !== "expired") continue;
        total++;
        this.log.warn("wait sweep: expired overdue wait", {
          kind: w.kind,
          id: w.id,
          runId: w.runId,
        });
        if (r.record) await this.resume(r.record.runId, w.id);
      } catch (err) {
        this.log.error("wait sweep: cannot expire overdue wait", { kind: w.kind, id: w.id, err });
      }
    }
    return total + (await this.sweepOverdueSubagents());
  }

  /**
   * Sub-agents waits past their `runs.wait_expires_at` (their timeout job was lost): expired the
   * way the timeout job would ({@link expire}: the step's active children stop as `timed out`, the
   * parent resumes once they are done). The step is the run's latest dispatch step: a waiting run
   * has active children only from the step it waits in. A run stays here until its children have
   * stopped; a pass that neither stopped a child nor resumed the run is not counted.
   */
  private async sweepOverdueSubagents(): Promise<number> {
    const runs = await this.db
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
        const last = await this.db
          .selectFrom("subagent_dispatches")
          .select(sql<number | null>`max(step)`.as("step"))
          .where("parent_run_id", "=", r.id)
          .executeTakeFirst();
        if (last?.step == null) continue;
        const step = Number(last.step);
        const id = subagentsWaitId(r.id, step);
        // children asked to stop may take a while to end, so the same wait can come back on the
        // next sweep: only a pass that stopped a child or resumed the run counts and logs (M3)
        const { acted } = await this.expire("subagents", id, { runId: r.id, step });
        if (!acted) continue;
        this.log.warn("wait sweep: expired overdue wait", { kind: "subagents", id, runId: r.id });
        total++;
      } catch (err) {
        this.log.error("wait sweep: cannot expire overdue wait", {
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
   * `run.orphaned` and reported to the parent, which then resumes. Also a chat run left `queued`
   * by a resume whose enqueue was lost (final review m8): enqueued again under its resume job id
   * (`ensureRun` would only repair it at the conversation's next message).
   */
  private async sweepSubagentOrphans(): Promise<{ requeued: number; orphaned: number }> {
    const out = { requeued: 0, orphaned: 0 };
    const runs = await this.db
      .selectFrom("runs")
      .innerJoin("conversations as c", "c.id", "runs.conversation_id")
      .select(["runs.id", "runs.conversation_id"])
      .where((eb) =>
        eb.or([
          eb.and([eb("c.kind", "=", "subagent"), eb("runs.status", "in", ["queued", "running"])]),
          // a parent (or any chat run) set `queued` by Waits.resume whose replica died before its
          // queue.add: child completions make that a frequent cross-replica resume (m8); its job
          // id is the resume job id recorded with the update
          eb.and([
            eb("c.kind", "=", "chat"),
            eb("runs.status", "=", "queued"),
            eb("runs.job_id", "like", "run-%-resume-%"),
          ]),
        ]),
      )
      .where(
        sql<Date>`COALESCE(runs.queued_at, runs.created_at)`,
        "<",
        sql<Date>`now() - ${WAIT_SWEEP_GRACE_MS}::integer * interval '1 millisecond'`,
      )
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    for (const run of runs) {
      try {
        const r = await this.runQueue.repairOrphan(run.conversation_id, run.id);
        if (r === null) continue;
        if (r === "failed") {
          out.orphaned++;
          await this.childFinished(run.id);
        } else out.requeued++;
        this.log.warn("wait sweep: repaired orphaned sub-agent run", {
          runId: run.id,
          conversationId: run.conversation_id,
          outcome: r,
        });
      } catch (err) {
        this.log.error("wait sweep: cannot repair orphaned sub-agent run", {
          runId: run.id,
          err,
        });
      }
    }
    return out;
  }

  /**
   * Finished parent runs (past the grace period, within the last day) with an `agent` call that has
   * no `tool_result` (final review I3): a terminal path that skipped `stopOpenAgentCalls`, such as
   * an old replica's abort, would otherwise leave an unpaired tool call that every later request of
   * the conversation sends and providers refuse. Each is repaired under the conversation row lock
   * with the normal `stopOpenCalls` (a child that ended gives its result, an active one the
   * stopped text; idempotency keys make it safe against the regular paths); its active children
   * are then stopped by {@link sweepChildrenOfFinished}.
   */
  private async sweepOpenAgentCalls(): Promise<number> {
    const agentCalls = await this.db
      .selectFrom("subagent_dispatches as sd")
      .innerJoin("runs as pr", "pr.id", "sd.parent_run_id")
      .select(["sd.parent_run_id", "sd.parent_conversation_id"])
      .distinct()
      .where("pr.status", "in", TERMINAL_RUN_STATUSES)
      .where(
        "pr.finished_at",
        "<",
        sql<Date>`now() - ${WAIT_SWEEP_GRACE_MS}::integer * interval '1 millisecond'`,
      )
      .where("pr.finished_at", ">", sql<Date>`now() - interval '1 day'`)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("conversation_events as e")
              .select(sql`1`.as("one"))
              .whereRef("e.conversation_id", "=", "sd.parent_conversation_id")
              .where(
                "e.idem_key",
                "=",
                sql<string>`'tool_result:' || sd.parent_run_id || ':' || sd.parent_call_id`,
              ),
          ),
        ),
      )
      // a fork invocation's dispatch (phase D) has no tool call: the query below covers it
      .where(sql<boolean>`NOT (sd.step = 0 AND sd.parent_call_id LIKE 'skill-%')`)
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    const forkRuns = await unreportedForkRuns(this.db);
    const runs = [...agentCalls, ...forkRuns].filter(
      (r, i, all) => all.findIndex((x) => x.parent_run_id === r.parent_run_id) === i,
    );
    let total = 0;
    for (const r of runs) {
      try {
        const st: { fire?: () => void } = {};
        const toSeq = await this.repairOpenAgentCallsIn(
          r.parent_conversation_id,
          r.parent_run_id,
          st,
        );
        const fire = st.fire;
        if (fire === undefined) continue;
        if (toSeq !== null) await this.eventLog.notify(r.parent_conversation_id, toSeq);
        fire();
        total++;
        this.log.warn("wait sweep: wrote missing agent results of a finished run", {
          runId: r.parent_run_id,
          conversationId: r.parent_conversation_id,
        });
      } catch (err) {
        this.log.error("wait sweep: cannot write missing agent results of a finished run", {
          runId: r.parent_run_id,
          err,
        });
      }
    }
    return total;
  }

  /** One run's repair of {@link sweepOpenAgentCalls}; its observe hooks go back through `st`. */
  @Transactional({ propagation: "requires_new" })
  private async repairOpenAgentCallsIn(
    conversationId: string,
    runId: string,
    st: { fire?: () => void },
  ): Promise<number | null> {
    const t = this.db;
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
      .executeTakeFirst();
    if (run === undefined || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
      return null;
    }
    const stopped = await this.pipeline.stopOpenAgentCalls(runId);
    if (stopped.callIds.size === 0) return null;
    st.fire = stopped.fire;
    return stopped.toSeq ?? null;
  }

  /**
   * Active sub-agent runs of a parent run that finished more than the grace period ago (spec §7.5,
   * §12: a parent's terminal state stops its children; this is the backstop) → stopped.
   */
  private async sweepChildrenOfFinished(): Promise<number> {
    const parents = await this.db
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
        const n = await this.stopChildren(p.parent_run_id, null);
        if (n === 0) continue;
        total += n;
        this.log.warn("wait sweep: stopped sub-agents of a finished run", {
          runId: p.parent_run_id,
          count: n,
        });
      } catch (err) {
        this.log.error("wait sweep: cannot stop sub-agents of a finished run", {
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
    const runs = await this.db
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
        this.log.warn("wait sweep: resumed stuck waiting run", {
          runId: run.id,
          conversationId: run.conversation_id,
          waitId,
        });
      } catch (err) {
        this.log.error("wait sweep: cannot resume stuck waiting run", { runId: run.id, err });
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
    const row = await this.db
      .selectFrom(
        this.db
          .selectFrom("approvals")
          .select(["id", "created_at"])
          .where("run_id", "=", runId)
          .unionAll(
            this.db
              .selectFrom("questions")
              .select(["id", "created_at"])
              .where("run_id", "=", runId),
          )
          .unionAll(
            this.db
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

  /**
   * A `wait-timeout` job (dispatched by `MaintenanceProcessor`): expires the wait,
   * or delays the job again until the wait's expiry when it ran early.
   */
  async processTimeout(job: Job<WaitTimeoutData>, token: string | undefined): Promise<void> {
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
      await this.timeouts.add(WAIT_TIMEOUT_JOB, data, {
        jobId: waitTimeoutJobId(w.id),
        delay: Math.max(0, new Date(w.expiresAt).getTime() - Date.now()),
        attempts: TIMEOUT_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: TIMEOUT_JOB_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (err) {
      this.log.error("cannot schedule wait timeout", { waitId: w.id, err });
    }
  }

  /**
   * Whether the wait is over: an approval or input request is no longer pending (decided, expired
   * or cancelled); `subagents`: no child run of the run is active.
   */
  private async isSettled(w: WaitingFor, runId: string): Promise<boolean> {
    if (w.kind === "subagents") {
      const active = await this.db
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
        ? await this.db
            .selectFrom("approvals")
            .select("status")
            .where("id", "=", w.id)
            .executeTakeFirst()
        : await this.db
            .selectFrom("questions")
            .select("status")
            .where("id", "=", w.id)
            .executeTakeFirst();
    return row !== undefined && row.status !== "pending";
  }

  /** 审批所在的步（`approval_requested` 事件里记的）。 */
  private async approvalStep(
    t: KernelSchemaDb,
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
    t: KernelSchemaDb,
    conversationId: string,
    runId: string,
    steps: number[],
    cancelled: Map<string, { toolKey: string; text: string }>,
    /** Calls whose result the caller writes itself (open `agent` calls). */
    skip: ReadonlySet<string> = new Set(),
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
        if (b.type !== "tool_call" || b.id === undefined || skip.has(b.id)) continue;
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

  /**
   * After a child run's terminal state committed (sub-agents spec §7.3): appends
   * `subagent_finished` to the parent log (idempotent; allowed while the parent waits, it is not
   * model-visible) and tries {@link resume}`(parentRunId, childRunId)`. Every finishing child tries;
   * the conditional resume lets exactly one succeed, the last to see all its siblings terminal. A
   * run that is not a dispatched child, or not terminal yet, is left alone. A crash in between is
   * repaired by the wait sweep and by the parent's tools node, which writes a missing
   * `subagent_finished` itself.
   */
  async childFinished(childRunId: string): Promise<void> {
    const row = await dispatchOfChildRun(this.db, childRunId);
    if (!row) return;
    const run = await this.db
      .selectFrom("runs")
      .select("status")
      .where("id", "=", childRunId)
      .executeTakeFirst();
    if (!run || !TERMINAL_STATUSES.has(run.status)) return;
    const r = await childResult(this.eventLog, row);
    if (!r) {
      this.log.warn("sub-agent run is terminal without a terminal event", { childRunId });
      return;
    }
    await this.eventLog.append(row.parentConversationId, [finishedEvent(row, r.finished)]);
    await this.resume(row.parentRunId, childRunId);
  }

  /**
   * Stops the active children of a parent run (sub-agents spec §12), or only those dispatched in
   * `opts.step`: a `waiting` child through its own {@link abortWaiting}, a `queued` / `running` one
   * that no worker holds directly (`RunQueue.abortIfOrphaned`), any other through
   * `RunAbort.request` (the cross-replica broadcast plus the marker key, so a child that starts
   * later still sees it), after which a child found `waiting` is stopped through `abortWaiting`
   * too. A child stopped here is reported to the parent at once (by `abortWaiting` itself, or
   * {@link childFinished} after `abortIfOrphaned`); one stopped by its worker is reported by that
   * worker. Returns the number of children asked to stop.
   *
   * `byAccountId` is the person whose action stops them, or null when the kernel stops them on the
   * parent's behalf; a child stopped with null reports the §4.4 "parent's stop" text.
   */
  async stopChildren(
    parentRunId: string,
    byAccountId: string | null,
    opts: { step?: number; detail?: RunAbortDetail } = {},
  ): Promise<number> {
    let q = this.db
      .selectFrom("subagent_dispatches as sd")
      .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
      .select(["sd.child_conversation_id", "sd.child_run_id", "cr.status"])
      .where("sd.parent_run_id", "=", parentRunId)
      .where("cr.status", "in", ACTIVE_RUN_STATUSES);
    if (opts.step !== undefined) q = q.where("sd.step", "=", opts.step);
    const children = await q.execute();
    for (const c of children) {
      const conv = c.child_conversation_id;
      const runId = c.child_run_id;
      // abortWaiting reports the stopped child to the parent itself (childFinished)
      if (
        c.status === "waiting" &&
        (await this.abortWaiting(conv, runId, byAccountId, opts.detail))
      ) {
        continue;
      }
      if (await this.runQueue.abortIfOrphaned(conv, runId, byAccountId, opts.detail)) {
        await this.childFinished(runId);
        continue;
      }
      await this.abort.request(runId, byAccountId, opts.detail);
      // the suspend handshake (see suspend): a child that became `waiting` after the read above
      // may have checked the marker before it was set, so check `waiting` again after setting it
      // (review M1)
      const now = await this.db
        .selectFrom("runs")
        .select("status")
        .where("id", "=", runId)
        .executeTakeFirst();
      if (now?.status === "waiting") {
        await this.abortWaiting(conv, runId, byAccountId, opts.detail);
      }
    }
    return children.length;
  }
}

/**
 * Phase D: finished chat runs (past the grace period, within the last day) triggered by a fork
 * invocation that has no report (dispatched or not); the wait sweep writes it
 * (`pairStoppedForks`).
 */
export function unreportedForkRuns(
  db: KernelSchemaDb,
): Promise<{ parent_run_id: string; parent_conversation_id: string }[]> {
  return (
    db
      .selectFrom("runs as r")
      .innerJoin("conversation_events as m", (j) =>
        j.onRef("m.conversation_id", "=", "r.conversation_id").onRef("m.seq", "=", "r.trigger_seq"),
      )
      // a sub-agent's task message carries the skill record too: chat conversations only (I1)
      .innerJoin("conversations as c", "c.id", "r.conversation_id")
      .select(["r.id as parent_run_id", "r.conversation_id as parent_conversation_id"])
      .where("c.kind", "=", "chat")
      .where("r.status", "in", TERMINAL_RUN_STATUSES)
      .where(
        "r.finished_at",
        "<",
        sql<Date>`now() - ${WAIT_SWEEP_GRACE_MS}::integer * interval '1 millisecond'`,
      )
      .where("r.finished_at", ">", sql<Date>`now() - interval '1 day'`)
      .where("m.type", "=", "user_message")
      .where(sql<boolean>`m.payload -> 'skill' ->> 'mode' = 'fork'`)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("conversation_events as e")
              .select(sql`1`.as("one"))
              .whereRef("e.conversation_id", "=", "r.conversation_id")
              .where("e.idem_key", "=", sql<string>`'skill_fork_result:' || r.trigger_seq`),
          ),
        ),
      )
      .limit(WAIT_SWEEP_BATCH)
      .execute()
  );
}

/**
 * A decided approval / answered question resumes the waiting run on this replica (domain events,
 * spec §3b; the wait sweep resumes a run whose resume was lost). Its IM delivery follows the same
 * events (`ChannelJobs`).
 */
@Injectable()
export class DecisionResumer implements OnModuleDestroy {
  private readonly unsubscribe: (() => void)[];

  constructor(
    @Inject(Waits) waits: Pick<Waits, "resume">,
    @Inject(KernelEvents) events: Pick<KernelEvents, "on">,
  ) {
    this.unsubscribe = [
      events.on("approval.decided", async (a) => {
        await waits.resume(a.runId, a.id);
      }),
      events.on("question.answered", async (q) => {
        await waits.resume(q.runId, q.id);
      }),
    ];
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribe) off();
  }
}

/**
 * The wait sweep (Task 22), every 10 minutes, once across replicas: {@link Waits.sweep}. Replaces
 * the maintenance scheduler `wait-sweep-every-10m` (retired at worker start).
 */
@Injectable()
export class WaitSweepJob {
  constructor(
    @Inject(Waits) private readonly waits: Pick<Waits, "sweep">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  @LockedCron("*/10 * * * *", { name: WAIT_SWEEP_JOB })
  async run(): Promise<void> {
    await this.waits.sweep();
  }
}
