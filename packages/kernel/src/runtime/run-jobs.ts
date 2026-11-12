import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { ConversationKind } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { OUTBOX_JOBS } from "../infra/outbox/registry.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";

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

/** 运行任务的数据。 */
export interface RunJobData {
  runId: string;
  conversationId: string;
}

/** 同一触发点（会话 + 最新用户消息 seq）只投递一次。 */
export const runJobId = (conversationId: string, maxUserSeq: number): string =>
  `run-${conversationId}-${maxUserSeq}`;

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
 * The options of every run job: one attempt (the run's own paths handle failures), not kept. The
 * outbox registry holds them, so a run job owed through the outbox is added with the same.
 */
const RUN_JOB_OPTIONS = OUTBOX_JOBS[RUN_JOB].opts;

/**
 * The producer side of the two run queues (`cap-kernel-runs`, `cap-kernel-subagent-runs`): owes
 * run jobs in the caller's transaction ({@link owe}, `ensureRun`), adds them directly under the
 * caller's job id (orphan repairs, the waits' resumes, the sub-agent dispatch) and looks them up;
 * the run worker consumes both queues.
 */
@Injectable()
export class RunJobs {
  private readonly queues: Record<string, Queue<RunJobData>>;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
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

  /**
   * Enqueues a run job under the caller's job id (`ensureRun`, resumes, dispatches, repairs). The
   * queue follows the conversation's kind (a sub-agent's runs go to
   * {@link SUBAGENT_RUN_QUEUE_NAME}); pass `kind` when the caller knows it, else it is read.
   */
  async enqueue(data: RunJobData, jobId: string, kind?: ConversationKind): Promise<void> {
    const k =
      kind ??
      (
        await this.kdb.db
          .selectFrom("conversations")
          .select("kind")
          .where("id", "=", data.conversationId)
          .executeTakeFirst()
      )?.kind ??
      "chat";
    await this.queue(runQueueNameFor(k)).add(RUN_JOB, data, { jobId, ...RUN_JOB_OPTIONS });
  }
}

/** The run queues' registration (re-exported: the admin health reads their counts). */
const RUN_QUEUES_MODULE = QueueModule.registerQueue(RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME);

/** The run queues' producer (the sub-agent dispatch, the run queue and the waits use it). */
@Module({
  imports: [RUN_QUEUES_MODULE],
  providers: [RunJobs],
  exports: [RunJobs, RUN_QUEUES_MODULE],
})
export class RunJobsModule {}
