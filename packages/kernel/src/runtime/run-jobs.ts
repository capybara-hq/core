import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Module } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { ConversationKind } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";

/** 内核运行队列的 BullMQ 队列名（不含 `:`；与插件队列 `cap.<插件>.<名>` 不会重名）。 */
export const RUN_QUEUE_NAME = "cap-kernel-runs";

/**
 * Queue of sub-agent (child) runs (sub-agents spec §7.4): a replica still on a version without
 * sub-agents never takes a child job, and child load shows apart from conversations.
 */
export const SUBAGENT_RUN_QUEUE_NAME = "cap-kernel-subagent-runs";

/** The run queue of a conversation kind: sub-agent conversations have their own. */
export const runQueueNameFor = (kind: ConversationKind): string =>
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

/** The options of every run job: one attempt (the run's own paths handle failures), not kept. */
const RUN_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: true } as const;

/**
 * The producer side of the two run queues (`cap-kernel-runs`, `cap-kernel-subagent-runs`): adds
 * run jobs under the caller's job id and looks them up. The run queue (`ensureRun`, orphan
 * repairs), the waits (resumes) and the sub-agent dispatch enqueue through it; the run worker
 * consumes both queues.
 */
@Injectable()
export class RunJobs {
  private readonly queues: Record<string, Queue<RunJobData>>;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(getQueueToken(RUN_QUEUE_NAME)) runs: Queue<RunJobData>,
    @Inject(getQueueToken(SUBAGENT_RUN_QUEUE_NAME)) subagentRuns: Queue<RunJobData>,
    @Inject(KERNEL_LOGGER) log: KernelLogger,
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

  /** Adds a conversation run job (`ensureRun`'s own enqueue). */
  async add(data: RunJobData, jobId: string): Promise<void> {
    await this.queue().add("run", data, { jobId, ...RUN_JOB_OPTIONS });
  }

  /**
   * Enqueues a run job under the caller's job id (resumes, dispatches, repairs). The queue follows
   * the conversation's kind (a sub-agent's runs go to {@link SUBAGENT_RUN_QUEUE_NAME}); pass
   * `kind` when the caller knows it, else it is read.
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
    await this.queue(runQueueNameFor(k)).add("run", data, { jobId, ...RUN_JOB_OPTIONS });
  }
}

/** The run queues' producer (the sub-agent dispatch, the run queue and the waits use it). */
@Module({
  imports: [QueueModule.registerQueue(RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME)],
  providers: [RunJobs],
  exports: [RunJobs],
})
export class RunJobsModule {}
