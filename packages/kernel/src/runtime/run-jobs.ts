import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { sql } from "kysely";
import type { ConversationKind, KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { QueueLostJobs } from "./queue-lost-jobs.js";

/** 内核运行队列的 BullMQ 队列名（不含 `:`；与插件队列 `cap.<插件>.<名>` 不会重名）。 */
export const RUN_QUEUE_NAME = "cap-kernel-runs";

/**
 * Queue of sub-agent (child) runs (sub-agents spec §7.4): a replica still on a version without
 * sub-agents never takes a child job, and child load shows apart from conversations.
 */
export const SUBAGENT_RUN_QUEUE_NAME = "cap-kernel-subagent-runs";

/** The run queue of a conversation kind: sub-agent conversations have their own. */
export const runQueueNameFor = (
  kind: ConversationKind,
): typeof RUN_QUEUE_NAME | typeof SUBAGENT_RUN_QUEUE_NAME =>
  kind === "subagent" ? SUBAGENT_RUN_QUEUE_NAME : RUN_QUEUE_NAME;

/** 未结束的运行状态（waiting：等人处理审批 / 输入请求，没有任务、不占会话锁与配额）。 */
export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting"] as const;

/** 运行的终态。 */
export type TerminalStatus = "completed" | "failed" | "aborted";

/** The terminal run statuses (here, not in `run-finish.ts`, which the sub-agent modules import). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set<TerminalStatus>([
  "completed",
  "failed",
  "aborted",
]);

/**
 * Locks a run's approval and input request rows (`FOR UPDATE`, in id order) in the caller's
 * transaction, after its conversation row and before its run row: the one lock order of every path
 * that writes them (conversation, decided rows, run; ruling R19), so a stop, a run's end, a decision
 * and a timeout never deadlock. Returns whether any of them is still pending.
 */
export async function lockWaitRowsIn(
  t: KernelSchemaDb,
  runId: string,
): Promise<{ approvals: boolean; questions: boolean }> {
  const approvals = await t
    .selectFrom("approvals")
    .select("status")
    .where("run_id", "=", runId)
    .orderBy("id")
    .forUpdate()
    .execute();
  const questions = await t
    .selectFrom("questions")
    .select("status")
    .where("run_id", "=", runId)
    .orderBy("id")
    .forUpdate()
    .execute();
  return {
    approvals: approvals.some((r) => r.status === "pending"),
    questions: questions.some((r) => r.status === "pending"),
  };
}

/** 运行任务的数据。 */
export interface RunJobData {
  runId: string;
  conversationId: string;
}

/** 同一触发点（会话 + 最新用户消息 seq）只投递一次。 */
export const runJobId = (conversationId: string, maxUserSeq: number): string =>
  `run-${conversationId}-${maxUserSeq}`;

/**
 * A resumed run's job id: apart from the per-message `run-<conversationId>-<seq>`, and one per
 * wait, so the same wait resumes its run once.
 */
export const resumeJobId = (conversationId: string, waitId: string): string =>
  `run-${conversationId}-resume-${waitId}`;

/** The BullMQ job name of every run job, on both run queues (an outbox registry name). */
export const RUN_JOB = "run";

/**
 * The ensure-run backstop (transactional outbox spec §6 "Sending a message"): a maintenance job
 * that calls `RunQueue.ensureRun` for a conversation. Every transaction that may start a run
 * after its commit (a message, a queue change, a background task's finish, a sub-agent's delivery,
 * a run's end) owes one, {@link ENSURE_RUN_BACKSTOP_MS} later, and its caller still calls
 * `ensureRun` right after the commit: the job only matters when that call never happened (the
 * process died) or failed (Redis was down).
 */
export const ENSURE_RUN_JOB = "ensure-run";

/** How long after its transaction the ensure-run backstop fires (a backstop, not a second call). */
export const ENSURE_RUN_BACKSTOP_MS = 30_000;

/** The ensure-run job's data. */
export interface EnsureRunJobData {
  conversationId: string;
}

/**
 * The ensure-run job id: one per conversation and the seq of the event the transaction wrote (a
 * write without an event of its own uses the conversation's newest seq; no `:`).
 */
export const ensureRunJobId = (conversationId: string, seq: number | string): string =>
  `ensure-run-${conversationId}-${seq}`;

/**
 * Owes the ensure-run backstop of `conversationId` in the caller's transaction (throws outside
 * one). False when the same job id is already owed (the owed job does the same).
 */
export function oweEnsureRun(
  outbox: Pick<OutboxService, "add">,
  conversationId: string,
  seq: number | string,
  orgId: string,
): Promise<boolean> {
  return outbox.add<EnsureRunJobData>({
    queue: MAINTENANCE_QUEUE_NAME,
    name: ENSURE_RUN_JOB,
    jobId: ensureRunJobId(conversationId, seq),
    data: { conversationId },
    runAt: new Date(Date.now() + ENSURE_RUN_BACKSTOP_MS),
    orgId,
  });
}

/**
 * The producer side of the two run queues (`cap-kernel-runs`, `cap-kernel-subagent-runs`): owes
 * run jobs in the caller's transaction ({@link owe}: `ensureRun`, the sub-agent dispatch, the
 * `run-orphan-check`) and looks them up; the run worker consumes both queues.
 */
@Injectable()
export class RunJobs {
  private readonly queues: Record<string, Queue<RunJobData>>;

  constructor(
    @Inject(getQueueToken(RUN_QUEUE_NAME)) runs: Queue<RunJobData>,
    @Inject(getQueueToken(SUBAGENT_RUN_QUEUE_NAME)) subagentRuns: Queue<RunJobData>,
    @Inject(KERNEL_LOGGER) log: KernelLogger,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {
    this.queues = { [RUN_QUEUE_NAME]: runs, [SUBAGENT_RUN_QUEUE_NAME]: subagentRuns };
    for (const [name, q] of Object.entries(this.queues)) {
      q.on("error", (err) => log.error("run queue error", { err, queue: name }));
    }
  }

  /** The BullMQ queue `name` (default: conversation runs). */
  queue(name: string = RUN_QUEUE_NAME): Queue<RunJobData> {
    const q = this.queues[name];
    if (!q) throw new Error(`unknown run queue ${name}`);
    return q;
  }

  /** A run job by id on the queue `name`, or undefined. */
  getJob(jobId: string, name: string = RUN_QUEUE_NAME): Promise<Job<RunJobData> | undefined> {
    return this.queue(name).getJob(jobId);
  }

  /**
   * Owes the run job in the caller's transaction (transactional outbox spec §6): the outbox row
   * commits or rolls back with the run row, on the queue of the conversation's `kind`. Returns
   * false when the same job id is already owed (nothing written; the caller creates no run).
   */
  owe(data: RunJobData, jobId: string, kind: ConversationKind, orgId: string): Promise<boolean> {
    return this.outbox.add({
      queue: runQueueNameFor(kind),
      name: RUN_JOB,
      jobId,
      data,
      orgId,
    });
  }

  /** {@link oweEnsureRun} in the caller's transaction. */
  oweEnsureRun(conversationId: string, seq: number | string, orgId: string): Promise<boolean> {
    return oweEnsureRun(this.outbox, conversationId, seq, orgId);
  }
}

/**
 * What {@link RunResume.resumeIn} found: `queued`, the run was waiting on nothing else and now is
 * queued with its resume job owed; `still-running`, the run has not reached `waiting` yet (its
 * suspend's re-check resumes it); `other-wait-pending`, the run still waits on another approval,
 * input request or fork sub-agent; `not-waiting`, the run is queued or finished (or gone).
 */
export type ResumeOutcome = "queued" | "still-running" | "other-wait-pending" | "not-waiting";

/**
 * The resume of a waiting run (transactional outbox spec §6 "Resumes and timeouts", "Decisions
 * resume in their own transaction"), in the caller's transaction. A decision (approvals, questions,
 * a reply's skips) calls it after writing the decided row, so the lock order is the decided row,
 * then the `runs` row. It lives beside the run jobs, not in `Waits`, so the tools domain (which the
 * runtime imports) can call it; `Waits.resume` wraps it in a transaction of its own.
 */
@Injectable()
export class RunResume {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * Locks the run row (`FOR UPDATE`); when it is `waiting` and waits on nothing else (no pending
   * approval or input request, no active fork sub-agent), sets it `queued` (adding this wait's
   * time to `waited_ms`, recording the resume job id) and owes the resume job
   * {@link resumeJobId}`(conversation, waitId)` on its conversation kind's run queue. A `running`
   * run is left alone: its suspend has not set `waiting` yet and re-checks the wait after.
   */
  @Transactional({ propagation: "mandatory" })
  async resumeIn(runId: string, waitId: string): Promise<ResumeOutcome> {
    const t = this.kdb.db;
    const run = await t
      .selectFrom("runs")
      .select("status")
      .where("id", "=", runId)
      .forUpdate()
      .executeTakeFirst();
    if (run?.status === "running") return "still-running";
    if (run?.status !== "waiting") return "not-waiting";
    const row = await t
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
      // a fork invocation's sub-agent (agent map spec §5.4: background `Agent` children never
      // hold their parent run) is no longer active
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("subagent_dispatches as sd")
              .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
              .select(sql`1`.as("one"))
              .where("sd.parent_run_id", "=", runId)
              .where("sd.for_skill", "=", true)
              .where("cr.status", "in", ACTIVE_RUN_STATUSES),
          ),
        ),
      )
      .returning("conversation_id")
      .executeTakeFirst();
    if (!row) return "other-wait-pending";
    const conv = await t
      .selectFrom("conversations")
      .select(["kind", "org_id"])
      .where("id", "=", row.conversation_id)
      .executeTakeFirstOrThrow();
    await this.outbox.add<RunJobData>({
      queue: runQueueNameFor(conv.kind),
      name: RUN_JOB,
      jobId: resumeJobId(row.conversation_id, waitId),
      data: { runId, conversationId: row.conversation_id },
      orgId: conv.org_id,
    });
    return "queued";
  }
}

/** The run queues' registration (re-exported: the admin health reads their counts). */
const RUN_QUEUES_MODULE = QueueModule.registerQueue(RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME);

/**
 * The run queues' producer (the sub-agent dispatch, the run queue and the waits use it), the
 * resume of a waiting run (the waits and the decisions of the tools domain use it) and the
 * lost-jobs canary of the run queues (the `run-orphan-check` reports it, the admin overview reads
 * it).
 */
@Module({
  imports: [RUN_QUEUES_MODULE],
  providers: [RunJobs, RunResume, QueueLostJobs],
  exports: [RunJobs, RunResume, QueueLostJobs, RUN_QUEUES_MODULE],
})
export class RunJobsModule {}
