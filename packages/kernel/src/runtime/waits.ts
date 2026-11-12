import type { Logger } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { DelayedError, type Job } from "bullmq";
import { sql } from "kysely";
import { BackgroundTaskStopper } from "../background/stop.js";
import { type AppendEvent, EventLog } from "../conversations/event-log.js";
import { conversationTree } from "../conversations/tree.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { OrgRole } from "../orgs/roles.js";
import {
  ApprovalsService,
  NETWORK_ASK_CANCELLED_NOTE,
  type NetworkAskDetail,
} from "../tools/approvals.service.js";
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
import { type ResumeOutcome, RunResume, resumeJobId } from "./run-jobs.js";
import { ACTIVE_RUN_STATUSES, RunQueue } from "./run-queue.js";
import {
  childResult,
  deliveryRowOfChildRun,
  finishedEvent,
  rootSurfaceOf,
} from "./subagents/child.js";
import { SubagentDeliveries } from "./subagents/deliveries.js";

/** 等待超时任务所在的内核维护队列（见 maintenance.ts）。 */
export { MAINTENANCE_QUEUE_NAME };

/** 等待超时任务的名字与 jobId（每个审批 / 输入请求一个，重复投递被 BullMQ 忽略）。 */
export const WAIT_TIMEOUT_JOB = "wait-timeout";
export const waitTimeoutJobId = (waitId: string): string => `wait-timeout-${waitId}`;

/** A resumed run's job id (`run-<conversationId>-resume-<waitId>`; `RunResume` owes it). */
export { resumeJobId };

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
   * Finished runs whose fork invocation had no report, repaired (`pairStoppedForks`; the next run
   * would build on a fork lead without its report).
   */
  repaired: number;
  /** Queued sub-agent runs, and chat runs queued by a resume, whose job was lost, enqueued again. */
  requeued: number;
  /** Running sub-agent runs without job or lock, failed `run.orphaned` and reported to the parent. */
  orphaned: number;
  /**
   * Active fork sub-agent runs of a finished parent run, and active sub-agent runs of a deleted
   * conversation's tree, asked to stop.
   */
  stopped: number;
  /**
   * Finished background sub-agent runs whose `finished` delivery was never written (the finisher
   * died after the child's terminal commit), delivered (agent map spec §10).
   */
  delivered: number;
  /**
   * Idle sub-agents with a parked message no run took (a `SendMessage` that reached a run after
   * its last model call, whose replica died before the post-run `ensureRun`), started again.
   */
  restarted: number;
}

const TERMINAL_RUN_STATUSES = ["completed", "failed", "aborted"] as const;

/** Who may decide a sub-agent's approval, mirrored into the root's `subagent_waiting`. */
type Approver = { requestedFor: string | null; approverRole: OrgRole | null };

/** The `tool_result` a stopped run writes for a call that waited (default: an error). */
type StoppedResult = { toolKey: string; text: string; isError?: boolean };

/** The data of a wait timeout job; `subagents` waits also carry their run and step. */
export interface WaitTimeoutData {
  kind: WaitingFor["kind"];
  id: string;
  runId?: string;
  step?: number;
}

/**
 * Runs waiting for a person (spec 4.4 / Task 9): suspend, resume, timeout and stop. All state is in
 * PG (`runs.status = 'waiting'`, the `approvals` / `questions` rows); delays and retries are BullMQ
 * jobs (the maintenance queue's `wait-timeout`) owed through the outbox; no in-process state.
 *
 * One resume only: a resume locks the run row and moves it `waiting → queued` only when it waits on
 * nothing else, owing the run job `run-<conversationId>-resume-<waitId>` in the same transaction
 * (transactional outbox spec §6). A decision does it in its own transaction ({@link resumeIn});
 * the timeout job, the suspend's re-check and the sweeps through {@link resume}. Whichever comes
 * first, the run resumes once.
 */
@Injectable()
export class Waits implements OnApplicationShutdown {
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
    private readonly runQueue: Pick<RunQueue, "repairOrphan" | "abortIfOrphaned" | "ensureRun">,
    /**
     * Writes, in the caller's transaction, the results of a stopped run's open `Agent` calls;
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
    /** Owes the wait timeout jobs (`MaintenanceProcessor` consumes them) with the suspend. */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    /** The resume of a waiting run, in the caller's transaction ({@link resumeIn}). */
    @Inject(RunResume) private readonly resumes: Pick<RunResume, "resumeIn">,
    @Inject(KernelEvents) private readonly events: KernelEvents,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "error" | "warn">,
    /** Stops a finished sub-agent run's background tasks ({@link childFinished}). */
    @Inject(BackgroundTaskStopper)
    private readonly background: Pick<BackgroundTaskStopper, "stopSubagentTasks">,
    /** Delivers a background child's finish to its parent ({@link childFinished}). */
    @Inject(SubagentDeliveries)
    private readonly deliveries: Pick<SubagentDeliveries, "childFinished">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {
    // an orphaned parent run (marked failed by `ensureRun`) stops its fork child at once
    // (background children keep running, agent map spec §5.4); the sweep's
    // `sweepForkChildrenOfFinished` is the backstop
    this.unsubscribe = events.on("run.orphaned", ({ runId }) =>
      this.stopChildren(runId, null)
        .then(() => {})
        .catch((err) =>
          this.log.error("cannot stop the sub-agents of an orphaned run", { runId, err }),
        ),
    );
  }

  /** Unsubscribes after the stop phases: events emitted while they drain are still handled. */
  onApplicationShutdown(): void {
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
      delivered: 0,
      restarted: 0,
    };
    out.cancelled = await this.sweepFinishedRuns();
    out.expired = await this.sweepOverdue();
    Object.assign(out, await this.sweepSubagentOrphans());
    out.repaired = await this.sweepOpenAgentCalls();
    out.stopped =
      (await this.sweepForkChildrenOfFinished()) + (await this.sweepTreesOfDeletedRoots());
    out.delivered = await this.sweepUndelivered();
    out.restarted = await this.sweepParkedMessages();
    out.resumed = await this.sweepStuckRuns();
    return out;
  }

  /**
   * After the loop returned `suspended` (the worker released the conversation lock and the quota):
   * in one transaction the conditional `running → waiting` (recording `waiting_since`) and the
   * wait's timeout job (`runAt` = `expiresAt`); then a re-check whether the wait is already settled:
   * a decision that came while the run was still `running` did not resume it, so the re-check does.
   * A run no longer running (ended by another path) → nothing.
   * A stop received while suspending (`abort`), or found in the stop marker after `waiting` is set
   * → the wait is cancelled and the run ended as {@link abortWaiting} does (a stop arriving after
   * `waiting` is set is handled by `POST .../abort`, which sees `waiting`; neither side misses it).
   */
  async suspend(
    runId: string,
    conversationId: string,
    waitingFor: WaitingFor,
    abort?: RunAbortBy,
  ): Promise<void> {
    if (!(await this.suspendIn(runId, waitingFor))) {
      this.log.warn("run is no longer running; not suspending", { runId });
      return;
    }
    const stop = abort ?? (await this.abort.requested(runId)) ?? null;
    if (stop && (await this.abortWaiting(conversationId, runId, stop.byAccountId, stop.detail))) {
      return;
    }
    await this.surfaceInRoot(runId, conversationId, waitingFor);
    // A decision that locked the run while it was still `running` wrote nothing to it
    // (`RunResume.resumeIn`: "still-running"); its row lock held this suspend's update until it
    // committed, so this read, a new statement after that commit, sees the decided wait.
    if (await this.isSettled(waitingFor, runId)) await this.resume(runId, waitingFor.id);
  }

  /**
   * {@link suspend}'s transaction: the conditional `running → waiting` and the wait's timeout job
   * owed with it ({@link oweTimeout}). False when the run was no longer running (nothing written).
   */
  @Transactional({ propagation: "requires_new" })
  private async suspendIn(runId: string, waitingFor: WaitingFor): Promise<boolean> {
    const row = await this.db
      .updateTable("runs")
      .set({
        status: "waiting",
        waiting_since: sql<Date>`now()`,
        // a sub-agents wait has no row of its own: its expiry lives on the run, for the sweep
        wait_expires_at: waitingFor.kind === "subagents" ? new Date(waitingFor.expiresAt) : null,
      })
      .from("conversations")
      .whereRef("conversations.id", "=", "runs.conversation_id")
      .where("runs.id", "=", runId)
      .where("runs.status", "=", "running")
      .returning("conversations.org_id")
      .executeTakeFirst();
    if (!row) return false;
    await this.oweTimeout(waitingFor, runId, row.org_id);
    return true;
  }

  /**
   * A sub-agent's run waits for an approval or an input (sub-agents spec §9): appends
   * `subagent_waiting` to the **root** conversation of its tree, whatever its depth (agent map spec
   * §7, {@link rootSurfaceOf}; idem `subagent_waiting:<childRunId>:<waitId>`), so the web and the
   * channel outbound show the card where the person looks. The approval or question itself stays
   * the child run's, with the run's trigger account (inherited down the chain) as the person asked.
   * Not a run of a sub-agent, or a `subagents` wait: nothing. Display only: a failure is logged,
   * the wait goes on.
   */
  private async surfaceInRoot(
    runId: string,
    conversationId: string,
    waitingFor: WaitingFor,
  ): Promise<void> {
    if (waitingFor.kind === "subagents") return;
    try {
      const target = await rootSurfaceOf(this.db, conversationId, runId);
      if (!target) return;
      const row: { tool_key: string; expires_at: string | Date; approver?: Approver } | undefined =
        waitingFor.kind === "approval"
          ? await this.db
              .selectFrom("approvals")
              .select(["tool_key", "expires_at", "requested_for", "approver_role"])
              .where("id", "=", waitingFor.id)
              .executeTakeFirst()
              .then(
                (r) =>
                  r && {
                    tool_key: r.tool_key,
                    expires_at: r.expires_at,
                    approver: {
                      requestedFor: r.requested_for,
                      approverRole: r.approver_role as OrgRole | null,
                    },
                  },
              )
          : await this.db
              .selectFrom("questions")
              .select([sql<string>`spec->>'toolKey'`.as("tool_key"), "expires_at"])
              .where("id", "=", waitingFor.id)
              .executeTakeFirst();
      if (!row) return;
      await this.eventLog.append(target.conversationId, [
        {
          type: "subagent_waiting",
          runId: target.runId,
          idemKey: subagentWaitingIdemKey(runId, waitingFor.id),
          payload: {
            subagentId: conversationId,
            childRunId: runId,
            path: target.path,
            kind: waitingFor.kind,
            ...(waitingFor.kind === "approval"
              ? {
                  approvalId: waitingFor.id,
                  ...row.approver,
                }
              : { questionId: waitingFor.id }),
            toolKey: row.tool_key,
            expiresAt: new Date(row.expires_at).toISOString(),
          },
        },
      ]);
    } catch (err) {
      this.log.error("cannot surface a sub-agent's wait in its root conversation", { runId, err });
    }
  }

  /**
   * Resumes the run in its own transaction ({@link resumeIn}); true when this call queued it. The
   * wait timeout, the suspend's re-check, a fork child's finish and the sweeps use it.
   */
  @Transactional()
  async resume(runId: string, waitId: string): Promise<boolean> {
    return (await this.resumeIn(runId, waitId)) === "queued";
  }

  /**
   * In the caller's transaction (`mandatory`): locks the run row and, when it is `waiting` on
   * nothing else, sets it `queued` and owes its resume job `run-<conversationId>-resume-<waitId>`
   * (`RunResume.resumeIn`, which the tools domain's decisions call directly: the runtime imports
   * the tools domain, so they cannot reach this class). "still-running": nothing is written, the
   * run's suspend re-checks the wait after setting `waiting`.
   */
  @Transactional({ propagation: "mandatory" })
  async resumeIn(runId: string, waitId: string): Promise<ResumeOutcome> {
    return this.resumes.resumeIn(runId, waitId);
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
      // A safety net (spec §7.2, §12) of a fork invocation's wait: its child, still active, is
      // stopped and reports to the parent, which then resumes. The resume tried here
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
    // a stopped run stops its fork child (spec §12), on its behalf (no account: it reports
    // "stopped with this run"); background children keep running; the wait sweep is the backstop
    await this.stopChildren(runId, null).catch((err) =>
      this.log.error("cannot stop the sub-agents of a run", { runId, err }),
    );
    return true;
  }

  /** {@link abortWaiting}'s transaction; the open `Agent` calls it wrote go back through `st`. */
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
    const cancelled = new Map<string, StoppedResult>();
    const steps = new Set<number>();
    const approvals = await t
      .selectFrom("approvals")
      .select(["id", "call_id", "tool_key", "kind", "detail"])
      .where("run_id", "=", runId)
      .orderBy("created_at")
      .orderBy("attempt")
      .execute();
    for (const a of approvals) {
      // a network ask's command already ran: its kept result, then why access stays blocked
      // (network ask-to-allow spec §6.7)
      const kept =
        a.kind === "network" ? (a.detail as Pick<NetworkAskDetail, "result"> | null)?.result : null;
      cancelled.set(
        a.call_id,
        kept
          ? {
              toolKey: a.tool_key,
              text: `${kept.content}\n\n${NETWORK_ASK_CANCELLED_NOTE}`,
              isError: kept.isError,
            }
          : { toolKey: a.tool_key, text: APPROVAL_CANCELLED_TEXT },
      );
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
    // a run waiting on its fork invocation's sub-agent: the report (`pairStoppedForks`)
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
   * way the timeout job would ({@link expire}: the fork invocation's active child stops as
   * `timed out`, the parent resumes once it is done). Only fork invocations wait (agent map spec
   * §5.4); their step is the run's fork dispatch step. A run stays here until its children have
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
          .where("for_skill", "=", true)
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
   * Idle sub-agent conversations (no active run, not deleted) with a message newer than what they
   * consumed, written past the grace period and within the last day: a `SendMessage` that reached a
   * run after its last model call is started by that run's post-job `ensureRun`
   * (`RunQueue.childWakeIn`), which a replica dying after the terminal commit skips. Re-derived with
   * the same `ensureRun` (its rules decide: a paused root starts nothing). A sub-agent whose last
   * run was stopped (`aborted`) can never start from a message, so it is left out here, and the
   * newest conversations come first (active within the last day), so parked messages that cannot
   * start never fill the batch. Returns how many runs started.
   */
  private async sweepParkedMessages(): Promise<number> {
    const rows = await this.db
      .selectFrom("conversations as c")
      .select("c.id")
      .where("c.kind", "=", "subagent")
      .where("c.deleted_at", "is", null)
      // every append bumps `updated_at`: a message of the last day implies it (an index-friendly
      // bound before the event lookups)
      .where("c.updated_at", ">", sql<Date>`now() - interval '1 day'`)
      .where(
        (eb) =>
          sql<boolean>`(
            SELECT r.status FROM capybara.runs r WHERE r.conversation_id = ${eb.ref("c.id")}
            ORDER BY r.created_at DESC, r.id DESC LIMIT 1
          ) IS DISTINCT FROM 'aborted'`,
      )
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("conversation_events as e")
            .select(sql`1`.as("one"))
            .whereRef("e.conversation_id", "=", "c.id")
            .where("e.type", "=", "user_message")
            .whereRef("e.seq", ">", "c.consumed_seq")
            .where(
              "e.created_at",
              "<",
              sql<Date>`now() - ${WAIT_SWEEP_GRACE_MS}::integer * interval '1 millisecond'`,
            )
            .where("e.created_at", ">", sql<Date>`now() - interval '1 day'`),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("runs as r")
              .select(sql`1`.as("one"))
              .whereRef("r.conversation_id", "=", "c.id")
              .where("r.status", "in", ACTIVE_RUN_STATUSES),
          ),
        ),
      )
      .orderBy("c.updated_at", "desc")
      .orderBy("c.id")
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    let n = 0;
    for (const c of rows) {
      try {
        if ((await this.runQueue.ensureRun(c.id)) === null) continue;
        n++;
        this.log.warn("wait sweep: started a sub-agent's parked message", { conversationId: c.id });
      } catch (err) {
        this.log.error("wait sweep: cannot start a sub-agent's parked message", {
          conversationId: c.id,
          err,
        });
      }
    }
    return n;
  }

  /**
   * Finished runs (past the grace period, within the last day) triggered by a fork invocation that
   * has no report ({@link unreportedForkRuns}): a terminal path that skipped
   * `stopOpenAgentCalls`, such as an old replica's abort, would otherwise leave a fork lead without
   * its report. Each is repaired under the conversation row lock with the normal
   * `stopOpenAgentCalls` (an ended child gives its result, an active one the stopped text;
   * idempotency keys make it safe against the regular paths); an active fork child is then stopped
   * by {@link sweepForkChildrenOfFinished}. An `Agent` call has its result from its dispatch (agent
   * map spec §4.1).
   */
  private async sweepOpenAgentCalls(): Promise<number> {
    const runs = await unreportedForkRuns(this.db);
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
        this.log.warn("wait sweep: wrote the missing fork report of a finished run", {
          runId: r.parent_run_id,
          conversationId: r.parent_conversation_id,
        });
      } catch (err) {
        this.log.error("wait sweep: cannot write the missing fork report of a finished run", {
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
   * Active fork sub-agent runs (phase D, `for_skill`) of a parent run that finished more than the
   * grace period ago (§12: the run's terminal state stops its fork child and reports it stopped;
   * this is the backstop) → stopped. Background `Agent` children of a finished run are the normal
   * case and keep running (agent map spec §5.4).
   */
  private async sweepForkChildrenOfFinished(): Promise<number> {
    const parents = await this.db
      .selectFrom("subagent_dispatches as sd")
      .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
      .innerJoin("runs as pr", "pr.id", "sd.parent_run_id")
      .select("sd.parent_run_id")
      .distinct()
      .where("sd.for_skill", "=", true)
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
        this.log.warn("wait sweep: stopped the fork sub-agent of a finished run", {
          runId: p.parent_run_id,
          count: n,
        });
      } catch (err) {
        this.log.error("wait sweep: cannot stop the fork sub-agent of a finished run", {
          runId: p.parent_run_id,
          err,
        });
      }
    }
    return total;
  }

  /**
   * Active sub-agent runs with a deleted ancestor (agent map spec §10: deleting the root stops the
   * whole tree; the delete's own {@link stopTree} is the normal path, this the backstop for a crash
   * between marking the root deleted and stopping its tree, or a dispatch that raced it) → stopped
   * on the deleter's behalf (no account). No grace period: nothing in a deleted tree should run.
   */
  private async sweepTreesOfDeletedRoots(): Promise<number> {
    const r = await sql<{ run_id: string; conversation_id: string; status: string }>`
      WITH RECURSIVE up(run_id, conversation_id, status, ancestor, n) AS (
        SELECT r.id, r.conversation_id, r.status, c.parent_conversation_id, 1
        FROM capybara.runs r JOIN capybara.conversations c ON c.id = r.conversation_id
        WHERE r.status IN ('queued', 'running', 'waiting') AND c.kind = 'subagent'
          AND c.parent_conversation_id IS NOT NULL
        UNION ALL
        SELECT up.run_id, up.conversation_id, up.status, c.parent_conversation_id, up.n + 1
        FROM up JOIN capybara.conversations c ON c.id = up.ancestor
        WHERE c.deleted_at IS NULL AND c.parent_conversation_id IS NOT NULL AND up.n < 16
      )
      SELECT DISTINCT up.run_id, up.conversation_id, up.status
      FROM up JOIN capybara.conversations a ON a.id = up.ancestor
      WHERE a.deleted_at IS NOT NULL
      LIMIT ${WAIT_SWEEP_BATCH}`.execute(this.db);
    let total = 0;
    for (const run of r.rows) {
      try {
        // already asked to stop (a worker holds it and stops it at its next check): not again
        if (run.status === "running" && (await this.abort.requested(run.run_id)) !== null) continue;
        await this.stopRun(run.conversation_id, run.run_id, run.status, null);
        total++;
        this.log.warn("wait sweep: stopped a sub-agent run of a deleted conversation's tree", {
          runId: run.run_id,
        });
      } catch (err) {
        this.log.error("wait sweep: cannot stop a sub-agent run of a deleted tree", {
          runId: run.run_id,
          err,
        });
      }
    }
    return total;
  }

  /**
   * Background sub-agent runs that finished more than the grace period ago (within the last day)
   * whose parent has no `subagent_finished` for them (agent map spec §10: the finisher died after
   * the child's terminal commit; the finish path writes `subagent_finished` and the delivery in one
   * transaction) → {@link childFinished}, idempotent against a late finisher. Keyed on the child
   * run, so a run nobody dispatched (a wake run, §5.3) is repaired too, and on
   * `subagent_finished`, not on the delivery, so a child that finished before background
   * dispatch (its result was the `Agent` call's, its `subagent_finished` written then) is never
   * delivered a second time. Fork invocations' runs, a run without a terminal event in its log
   * (nothing to deliver), a conversation never dispatched and a child whose parent conversation
   * was deleted are skipped; only a written delivery counts.
   */
  private async sweepUndelivered(): Promise<number> {
    const runs = await this.db
      .selectFrom("runs as cr")
      .innerJoin("conversations as cc", "cc.id", "cr.conversation_id")
      .innerJoin("conversations as pc", "pc.id", "cc.parent_conversation_id")
      .select("cr.id as child_run_id")
      .where("cc.kind", "=", "subagent")
      .where("pc.deleted_at", "is", null)
      .where("cr.status", "in", TERMINAL_RUN_STATUSES)
      .where(
        "cr.finished_at",
        "<",
        sql<Date>`now() - ${WAIT_SWEEP_GRACE_MS}::integer * interval '1 millisecond'`,
      )
      .where("cr.finished_at", ">", sql<Date>`now() - interval '1 day'`)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("subagent_dispatches as sd")
            .select(sql`1`.as("one"))
            .whereRef("sd.child_conversation_id", "=", "cc.id"),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("subagent_dispatches as fd")
              .select(sql`1`.as("one"))
              .whereRef("fd.child_run_id", "=", "cr.id")
              .where("fd.for_skill", "=", true),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("conversation_events as e")
              .select(sql`1`.as("one"))
              .whereRef("e.conversation_id", "=", "pc.id")
              .where("e.idem_key", "=", sql<string>`'subagent_finished:' || cr.id`),
          ),
        ),
      )
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("conversation_events as t")
            .select(sql`1`.as("one"))
            .whereRef("t.conversation_id", "=", "cc.id")
            .whereRef("t.run_id", "=", "cr.id")
            .where("t.type", "in", ["run_finished", "run_failed", "run_aborted"]),
        ),
      )
      .limit(WAIT_SWEEP_BATCH)
      .execute();
    let total = 0;
    for (const r of runs) {
      try {
        if (!(await this.childFinished(r.child_run_id))) continue;
        total++;
        this.log.warn("wait sweep: delivered the finish of a sub-agent run", {
          childRunId: r.child_run_id,
        });
      } catch (err) {
        this.log.error("wait sweep: cannot deliver the finish of a sub-agent run", {
          childRunId: r.child_run_id,
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
      // the resume condition's third clause: a run with an active fork child is not stuck
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("subagent_dispatches as sd")
              .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
              .select(sql`1`.as("one"))
              .whereRef("sd.parent_run_id", "=", "runs.id")
              .where("sd.for_skill", "=", true)
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
   * The id of the run's latest wait (by creation time): an approval, an input request or a fork
   * invocation's dispatch, whose wait id is its child run id (the id the child's finisher resumes
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
              .where("parent_run_id", "=", runId)
              .where("for_skill", "=", true),
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

  /**
   * Owes the wait's timeout job (`wait-timeout-<waitId>`, `runAt` = the wait's deadline) in the
   * suspend's transaction (transactional outbox spec §6 "Resumes and timeouts").
   */
  private async oweTimeout(w: WaitingFor, runId: string, orgId: string): Promise<void> {
    const data: WaitTimeoutData =
      w.kind === "subagents" && w.step !== undefined
        ? { kind: w.kind, id: w.id, runId, step: w.step }
        : { kind: w.kind, id: w.id };
    await this.outbox.add<WaitTimeoutData>({
      queue: MAINTENANCE_QUEUE_NAME,
      name: WAIT_TIMEOUT_JOB,
      jobId: waitTimeoutJobId(w.id),
      data,
      runAt: new Date(w.expiresAt),
      orgId,
    });
  }

  /**
   * Whether the wait is over: an approval or input request is no longer pending (decided, expired
   * or cancelled); `subagents`: the run's fork invocation child is no longer active.
   */
  private async isSettled(w: WaitingFor, runId: string): Promise<boolean> {
    if (w.kind === "subagents") {
      const active = await this.db
        .selectFrom("subagent_dispatches as sd")
        .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
        .select("cr.id")
        .where("sd.parent_run_id", "=", runId)
        .where("sd.for_skill", "=", true)
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
    cancelled: Map<string, StoppedResult>,
    /** Calls whose result the caller writes itself (open `Agent` calls). */
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
            isError: c?.isError ?? true,
          },
        });
      }
    }
    return out;
  }

  /**
   * After a child run's terminal state committed (sub-agents spec §7.3, agent map spec §4.5,
   * §5.2): a background child's run, whether dispatched, sent a message or woken
   * ({@link deliveryRowOfChildRun}), is delivered to its parent
   * ({@link SubagentDeliveries.childFinished}: `subagent_finished` and a `finished` delivery,
   * idempotent by the run); a fork invocation's child (phase D, `for_skill`) appends
   * `subagent_finished` (idempotent; not model-visible) and tries
   * {@link resume}`(parentRunId, childRunId)`, which succeeds once its parent run waits on nothing
   * else. A run of a conversation never dispatched, or not terminal yet, is left alone. A crash in
   * between is repaired by the wait sweep (the orphan repair calls this again). A fork child's
   * running background tasks the terminal run started are then stopped (not those of a later run);
   * a stopped background child's are all stopped, whichever of its runs started them; a background
   * child that ended on its own keeps them, and their finish wakes it (agent map spec §5.3). True
   * when a background child's finish was written by this call.
   */
  async childFinished(childRunId: string): Promise<boolean> {
    const row = await deliveryRowOfChildRun(this.db, childRunId);
    if (!row) return false;
    const run = await this.db
      .selectFrom("runs")
      .select("status")
      .where("id", "=", childRunId)
      .executeTakeFirst();
    if (!run || !TERMINAL_STATUSES.has(run.status)) return false;
    if (row.forSkill !== true) {
      try {
        return await this.deliveries.childFinished(childRunId);
      } finally {
        // a background child that ended on its own keeps its tasks: their finish wakes it (agent
        // map spec §5.3); a stopped one's tasks all stop with it, also those an earlier run of it
        // started, so none of them wakes it. Once a later run of it exists (a `SendMessage`
        // started it again before this late call), only the stopped run's own tasks stop: the
        // others may be the new run's. Never throws.
        if (run.status === "aborted") {
          const later = await this.hasLaterRun(row.childConversationId, childRunId);
          await this.background.stopSubagentTasks(
            row.childConversationId,
            later ? childRunId : undefined,
          );
        }
      }
    }
    try {
      const r = await childResult(this.eventLog, row);
      if (!r) {
        this.log.warn("sub-agent run is terminal without a terminal event", { childRunId });
        return false;
      }
      await this.eventLog.append(row.parentConversationId, [finishedEvent(row, r.finished)]);
      await this.resume(row.parentRunId, childRunId);
      return false;
    } finally {
      // a fork child, whichever way its run ended (its worker, a stop while waiting, an orphan
      // repair): nobody reads or stops the background tasks that run started through its model
      // any more (background Bash spec §4.3); a background child's are handled above. Never throws.
      await this.background.stopSubagentTasks(row.childConversationId, childRunId);
    }
  }

  /**
   * Whether the conversation has an active run other than `runId`, or one created after it (a
   * sub-agent started again after `runId` ended).
   */
  private async hasLaterRun(conversationId: string, runId: string): Promise<boolean> {
    const hit = await this.db
      .selectFrom("runs as r")
      .select("r.id")
      .where("r.conversation_id", "=", conversationId)
      .where("r.id", "<>", runId)
      .where((eb) =>
        eb.or([
          eb("r.status", "in", ACTIVE_RUN_STATUSES),
          eb(
            "r.created_at",
            ">",
            eb.selectFrom("runs as o").select("o.created_at").where("o.id", "=", runId),
          ),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    return hit !== undefined;
  }

  /**
   * Stops the active fork invocation child of a parent run (sub-agents spec §12, phase D;
   * `for_skill`), or only one dispatched in `opts.step`; background `Agent` children are never
   * stopped with the run that dispatched them (agent map spec §5.4, §6): a `waiting` child through its own {@link abortWaiting}, a `queued` / `running` one
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
      .where("sd.for_skill", "=", true)
      .where("cr.status", "in", ACTIVE_RUN_STATUSES);
    if (opts.step !== undefined) q = q.where("sd.step", "=", opts.step);
    const children = await q.execute();
    for (const c of children) {
      await this.stopRun(
        c.child_conversation_id,
        c.child_run_id,
        c.status,
        byAccountId,
        opts.detail,
      );
    }
    return children.length;
  }

  /**
   * Stops a sub-agent with its descendants (agent map spec §6: stopping an agent of the map stops
   * it and everything below it; deleting the root stops the whole tree): every active run of
   * `conversationId` (unless `includeSelf` is false) and of each sub-agent conversation below it,
   * shallowest first, each the way {@link stopChildren} stops a child (a stopped agent delivers its
   * finish to its own parent as `aborted`). A run a worker holds ends later; its worker's
   * {@link stopDescendantsOfStopped} stops what it dispatched after this read. Then the running
   * background tasks of every covered sub-agent conversation stop, whether it was running or idle.
   * Returns the number of runs asked to stop.
   *
   * Lock order: nothing is held across runs. Each run's stop is its own transaction (or none), and
   * one that writes the terminal state locks that run's conversation row, then its run row, the
   * order of `StepLog.appendCounted` (conversation row, then the root's budget run row) and of
   * dispatch (conversation, run, budget run). No stop here locks a budget run, let alone before a
   * descendant's conversation row, so the order is never inverted.
   */
  async stopTree(
    conversationId: string,
    byAccountId: string | null,
    opts: { includeSelf?: boolean } = {},
  ): Promise<number> {
    const tree = await conversationTree(this.db, conversationId);
    const ids = tree.filter((c) => opts.includeSelf !== false || c.level > 0).map((c) => c.id);
    if (ids.length === 0) return 0;
    const level = new Map(tree.map((c) => [c.id, c.level]));
    const runs = (
      await this.db
        .selectFrom("runs")
        .select(["id", "conversation_id", "status"])
        .where("conversation_id", "in", ids)
        .where("status", "in", ACTIVE_RUN_STATUSES)
        .execute()
    ).sort((a, b) => (level.get(a.conversation_id) ?? 0) - (level.get(b.conversation_id) ?? 0));
    for (const r of runs) {
      try {
        if (await this.stopRun(r.conversation_id, r.id, r.status, byAccountId)) {
          // its approval / question cards changed (RunControl.abortWaiting's event)
          await this.events.emit("run.wait-stopped", {
            conversationId: r.conversation_id,
            runId: r.id,
          });
        }
      } catch (err) {
        this.log.error("cannot stop a sub-agent run of the tree", { runId: r.id, err });
      }
    }
    // every running background task of the covered sub-agents stops with them, idle ones too
    // (their finish would wake the idle agent, whose delivery would restart the stopped branch):
    // all of each conversation's tasks, as a stopped child's run end does (`childFinished`), with
    // which this is idempotent (only running tasks are stopped; `stoppedBy: "subagent_end"`
    // never wakes). A root conversation is skipped (`stopSubagentTasks`); never throws.
    await Promise.all(ids.map((id) => this.background.stopSubagentTasks(id)));
    return runs.length;
  }

  /**
   * After a sub-agent run's terminal commit (its worker): a run a person stopped (`run_aborted`
   * with an account and no `detail`; only {@link stopTree} stops a sub-agent's run that way) stops
   * the active runs below its conversation as well, so a descendant it dispatched after the tree
   * stop read the tree still stops (dispatch needs its run `running`, so after its terminal commit
   * the set is final). Any other end leaves its children running (agent map spec §5.4). Returns
   * the number of runs asked to stop. A root conversation's run never stops its children here.
   */
  async stopDescendantsOfStopped(runId: string): Promise<number> {
    const ev = await this.db
      .selectFrom("runs as r")
      .innerJoin("conversation_events as e", (j) =>
        j.onRef("e.conversation_id", "=", "r.conversation_id").onRef("e.run_id", "=", "r.id"),
      )
      .innerJoin("conversations as c", "c.id", "r.conversation_id")
      .select(["r.conversation_id", "e.payload"])
      .where("r.id", "=", runId)
      // a root's stop leaves its children running (agent map spec §6): a person-stopped root run
      // reaching here (a redelivered job, the failure path) stops nothing
      .where("c.kind", "=", "subagent")
      .where("r.status", "=", "aborted")
      .where("e.type", "=", "run_aborted")
      .executeTakeFirst();
    const p = ev?.payload as { byAccountId?: string | null; detail?: string } | undefined;
    if (!ev || typeof p?.byAccountId !== "string" || p.detail !== undefined) return 0;
    return this.stopTree(ev.conversation_id, p.byAccountId, { includeSelf: false });
  }

  /**
   * Stops one active sub-agent run: a `waiting` one through its own {@link abortWaiting}, a
   * `queued` / `running` one that no worker holds directly (`RunQueue.abortIfOrphaned`, then
   * reported through {@link childFinished}), any other through `RunAbort.request` (the
   * cross-replica broadcast plus the marker key, so a run that starts later still sees it), after
   * which a run found `waiting` is stopped through `abortWaiting` too. True when it was stopped
   * while waiting.
   */
  private async stopRun(
    conv: string,
    runId: string,
    status: string,
    byAccountId: string | null,
    detail?: RunAbortDetail,
  ): Promise<boolean> {
    // abortWaiting reports the stopped child to the parent itself (childFinished)
    if (status === "waiting" && (await this.abortWaiting(conv, runId, byAccountId, detail))) {
      return true;
    }
    if (await this.runQueue.abortIfOrphaned(conv, runId, byAccountId, detail)) {
      await this.childFinished(runId);
      return false;
    }
    await this.abort.request(runId, byAccountId, detail);
    // the suspend handshake (see suspend): a run that became `waiting` after the read above may
    // have checked the marker before it was set, so check `waiting` again after setting it
    // (review M1)
    const now = await this.db
      .selectFrom("runs")
      .select("status")
      .where("id", "=", runId)
      .executeTakeFirst();
    return now?.status === "waiting" && (await this.abortWaiting(conv, runId, byAccountId, detail));
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
 * The wait sweep, every 10 minutes, once across replicas: {@link Waits.sweep}. Replaces
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
