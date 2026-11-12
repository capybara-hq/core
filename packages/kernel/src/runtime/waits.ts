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
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
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
import { subagentWaitingIdemKey, type WaitingFor } from "./loop.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { assistantIdemKey } from "./model-call.js";
import { notifyFinished, RunFinish } from "./run-finish.js";
import { lockWaitRowsIn, RunResume, resumeJobId, TERMINAL_STATUSES } from "./run-jobs.js";
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
 * (transactional outbox spec §6). A decision does it in its own transaction
 * (`RunResume.resumeIn`); the timeout job, the suspend's re-check and a fork child's finish
 * through {@link resume}. Whichever comes first, the run resumes once.
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
    /** Stops a queued or running sub-agent no worker holds directly ({@link stopRun}). */
    @Inject(RunQueue) private readonly runQueue: Pick<RunQueue, "abortIfOrphaned">,
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
    /** The resume of a waiting run, in the caller's transaction ({@link resume}). */
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
    // an orphaned parent run (failed by the `run-orphan-check`) stops its fork child at once
    // (background children keep running, agent map spec §5.4); the `stop-tree` job its terminal
    // transaction owed is the backstop
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
   * After the loop returned `suspended` (the worker released the conversation lock and the quota):
   * in one transaction the conditional `running → waiting` (recording `waiting_since`) and the
   * wait's timeout job (`runAt` = `expiresAt`); then a re-check whether the wait is already
   * settled: a decision that came while the run was still `running` did not resume it, so the
   * re-check does.
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
        // a sub-agents wait has no row of its own: its expiry is kept on the run (its timeout job
        // carries the run and step)
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
   * Resumes the run in its own transaction (`RunResume.resumeIn`: locks the run row and, when it
   * is `waiting` on nothing else, sets it `queued` and owes its resume job); true when this call
   * queued it. The wait timeout, the suspend's re-check and a fork child's finish use it; the decisions call `RunResume.resumeIn` in their own transactions.
   */
  @Transactional()
  async resume(runId: string, waitId: string): Promise<boolean> {
    return (await this.resumes.resumeIn(runId, waitId)) === "queued";
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
    // a stopped sub-agent reports to its parent now, not when the owed `deliver-to-parent` job
    // runs (a no-op for other runs)
    await this.childFinished(runId).catch((err) =>
      this.log.error("cannot report stopped sub-agent run", { runId, err }),
    );
    // a stopped run stops its fork child (spec §12), on its behalf (no account: it reports
    // "stopped with this run"); background children keep running; the `stop-tree` job the
    // terminal transaction owed is the backstop
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
    await lockWaitRowsIn(t, runId);
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
   * between is repaired by the `deliver-to-parent` job its terminal transaction owed (the
   * `run-orphan-check` calls this too). A fork child's
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
