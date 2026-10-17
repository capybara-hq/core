import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { KernelDb } from "../db/kernel-schema.js";
import type { ConversationLock } from "./conversation-lock.js";

/** 内核运行队列的 BullMQ 队列名（不含 `:`；与插件队列 `cap.<插件>.<名>` 不会重名）。 */
export const RUN_QUEUE_NAME = "cap-kernel-runs";

/** 运行任务的数据。 */
export interface RunJobData {
  runId: string;
  conversationId: string;
}

/** 同一触发点（会话 + 最新用户消息 seq）只投递一次。 */
export const runJobId = (conversationId: string, maxUserSeq: number): string =>
  `run-${conversationId}-${maxUserSeq}`;

/** 未结束的运行状态。 */
export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

/** BullMQ 连接要求 maxRetriesPerRequest 为 null（Worker 的阻塞连接）；Queue 复用同样的配置。 */
export function bullConnection(redisUrl: string, log: Pick<Logger, "error">): Redis {
  const c = new Redis(redisUrl, { maxRetriesPerRequest: null });
  c.on("error", (err: Error) => log.error("run queue redis connection error", { err }));
  return c;
}

/**
 * 运行队列（生产方）：`ensureRun` 在会话有未消费的用户消息、且没有进行中的运行时插入 `runs` 行并投递任务。
 * 「是否已有运行」以 PG 为准（会话行锁内检查 `runs` 中的 queued / running），并参考会话锁的持有者；
 * 多副本并发调用对同一会话串行化，同一时刻至多一个未结束的运行。
 */
export class RunQueue {
  private queue: Queue<RunJobData> | undefined;
  private conn: Redis | undefined;
  private closed = false;

  constructor(
    private readonly db: KernelDb,
    private readonly lock: Pick<ConversationLock, "holder">,
    private readonly redisUrl: string,
    private readonly log: Pick<Logger, "error" | "warn">,
  ) {}

  private getQueue(): Queue<RunJobData> {
    if (this.closed) throw new Error("run queue is closed");
    if (!this.queue) {
      this.conn = bullConnection(this.redisUrl, this.log);
      this.queue = new Queue<RunJobData>(RUN_QUEUE_NAME, { connection: this.conn });
      this.queue.on("error", (err) => this.log.error("run queue error", { err }));
    }
    return this.queue;
  }

  /**
   * 有未消费的用户消息（最新 user_message 的 seq > `consumed_seq`）、会话锁无人持有、
   * 且没有 queued / running 的运行时：插入 `runs`（queued）并投递任务，返回 runId；否则返回 null。
   */
  async ensureRun(conversationId: string): Promise<string | null> {
    if ((await this.lock.holder(conversationId)) !== null) return null;
    const created = await this.db.transaction().execute(async (t) => {
      const conv = await t
        .selectFrom("conversations")
        .select(["consumed_seq", "agent_id"])
        .where("id", "=", conversationId)
        .forUpdate()
        .executeTakeFirst();
      if (!conv) return null;
      const last = await t
        .selectFrom("conversation_events")
        .select(["seq", "payload"])
        .where("conversation_id", "=", conversationId)
        .where("type", "=", "user_message")
        .orderBy("seq", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!last || Number(last.seq) <= Number(conv.consumed_seq)) return null;
      const active = await t
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .where("status", "in", ACTIVE_RUN_STATUSES)
        .executeTakeFirst();
      if (active) return null;
      // BullMQ 对重复的 jobId 静默忽略（add 返回的 Job 由调用方数据构造，看不出是否真的入队）：
      // 先显式查同一触发点的任务；仍存在（例如属于刚结束、尚未从队列移除的运行）就不插入 runs 行。
      const jobId = runJobId(conversationId, Number(last.seq));
      const existing = await this.getQueue().getJob(jobId);
      if (existing) {
        this.log.warn("run job for this trigger already exists; not enqueuing", {
          conversationId,
          jobId,
          existingRunId: existing.data?.runId,
        });
        return null;
      }
      const agent = await t
        .selectFrom("agents")
        .select("current_version")
        .where("id", "=", conv.agent_id)
        .executeTakeFirstOrThrow();
      const runId = randomUUID();
      await t
        .insertInto("runs")
        .values({
          id: runId,
          conversation_id: conversationId,
          status: "queued",
          agent_version: agent.current_version,
          trigger_account_id: (last.payload as { authorAccountId: string }).authorAccountId,
          trigger_seq: Number(last.seq),
        })
        .execute();
      return { runId, jobId };
    });
    if (!created) return null;
    const { runId, jobId } = created;
    try {
      const queue = this.getQueue();
      await queue.add(
        "run",
        { runId, conversationId },
        { jobId, attempts: 1, removeOnComplete: true, removeOnFail: true },
      );
      // 从 Redis 读回核对：检查与 add 之间出现了同 jobId 的任务时 add 被静默忽略，撤销本次插入，
      // 不留下没有任务的 queued 行。读不到说明任务已被领取并移除（只可能是本次投递的），不撤销。
      const stored = await queue.getJob(jobId);
      if (stored && stored.data.runId !== runId) {
        this.log.warn("run job already queued for this trigger", {
          conversationId,
          runId,
          existingRunId: stored.data.runId,
        });
        await this.deleteQueued(runId);
        return null;
      }
    } catch (err) {
      // 投递失败：撤销 queued 行，避免会话卡在「有运行但没有任务」。
      await this.deleteQueued(runId).catch(() => {});
      throw err;
    }
    return runId;
  }

  private async deleteQueued(runId: string): Promise<void> {
    await this.db
      .deleteFrom("runs")
      .where("id", "=", runId)
      .where("status", "=", "queued")
      .execute();
  }

  async close(): Promise<void> {
    this.closed = true;
    const q = this.queue;
    const c = this.conn;
    this.queue = undefined;
    this.conn = undefined;
    await q?.close().catch(() => {});
    if (c) await c.quit().catch(() => c.disconnect());
  }
}
