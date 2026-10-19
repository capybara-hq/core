import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import type { EventLog } from "../conversations/event-log.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import type { KyselyCheckpointSaver } from "./checkpointer.js";
import type { ConversationLock } from "./conversation-lock.js";
import { finishRunIn } from "./run-finish.js";

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

/** 未结束的运行状态（waiting：等人处理审批 / 输入请求，没有任务、不占会话锁与配额）。 */
export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting"] as const;

/**
 * queued 运行的宽限期（秒）：`ensureRun` / 续跑先提交 runs 行、再投递任务，两步之间任务暂时不存在；
 * 只有进入 queued 超过这么久（`COALESCE(queued_at, created_at)`）仍没有任务的 queued 行才视为孤儿。
 */
const ORPHAN_QUEUED_GRACE_SECONDS = 30;

type KernelTrx = Transaction<KernelDatabase>;

/** 孤儿判定需要的运行字段。 */
interface ActiveRunRow {
  id: string;
  status: string;
  trigger_seq: string;
  /** 续跑任务的 jobId；为空表示按触发消息生成的 jobId。 */
  job_id: string | null;
  past_grace: boolean;
}

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
    private readonly eventLog: EventLog,
    private readonly lock: Pick<ConversationLock, "holder">,
    private readonly redisUrl: string,
    private readonly log: Pick<Logger, "error" | "warn">,
    /** 运行以孤儿结束（标记失败 / 直接中止）后删除它的 checkpoint thread（thread_id = runId）。 */
    private readonly checkpoints?: Pick<KyselyCheckpointSaver, "deleteThread">,
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
   * 且没有 queued / running / waiting 的运行时：插入 `runs`（queued）并投递任务，返回 runId；否则返回 null。
   *
   * 孤儿清理（R29，按需进行，没有定时器）：已有的 queued / running 运行若 BullMQ 任务已不存在、
   * 会话锁也无人持有（queued 的还要超过宽限期），说明没有任何 worker 会再执行它——写
   * `run_failed { code: "run.orphaned" }` 把它标记为失败（consumed_seq 推进到它的触发消息），
   * 再按常规判断是否起新一轮，并删除它的 checkpoint thread。会话因此不会永远卡在「有运行」。
   * 除了写入消息后，打开 SSE、读事件、运行结束后也会调用它（幂等），孤儿因此在有人查看时就被清理。
   *
   * agent 已软删除的会话不起新运行（孤儿清理照常进行）。
   */
  async ensureRun(conversationId: string): Promise<string | null> {
    if ((await this.lock.holder(conversationId)) !== null) return null;
    let orphanSeq: number | null = null;
    let orphanRunId: string | null = null;
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
      const active = await this.activeRun(t, conversationId);
      if (active) {
        if (!(await this.isOrphan(conversationId, active))) return null;
        this.log.warn("marking orphaned run as failed", { conversationId, runId: active.id });
        orphanRunId = active.id;
        orphanSeq = await finishRunIn(t, this.eventLog, {
          conversationId,
          runId: active.id,
          status: "failed",
          consumed: null,
          event: {
            type: "run_failed",
            payload: {
              error: { code: "run.orphaned", message: "The run was lost and will not continue" },
            },
          },
        });
        // 孤儿运行的触发消息已被消费：之后没有更新的消息就不起新一轮。
        if (Number(last.seq) <= Math.max(Number(conv.consumed_seq), Number(active.trigger_seq))) {
          return null;
        }
      }
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
        .select(["current_version", "deleted_at"])
        .where("id", "=", conv.agent_id)
        .executeTakeFirstOrThrow();
      // agent 已软删除：会话对任何人都不可见，不再为它起运行。
      if (agent.deleted_at !== null) return null;
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
    if (orphanSeq !== null) await this.eventLog.notify(conversationId, orphanSeq);
    if (orphanRunId !== null) await this.dropCheckpoints(orphanRunId);
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

  /** 投递一个运行任务（续跑用，jobId 由调用方给出；选项与 `ensureRun` 投递的一致）。 */
  async enqueue(data: RunJobData, jobId: string): Promise<void> {
    await this.getQueue().add("run", data, {
      jobId,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /**
   * 中止一个孤儿运行（`POST .../abort` 用）：运行仍是 queued / running、会话锁无人持有、BullMQ 任务已不存在
   * （queued 的还要超过宽限期，判定同 {@link ensureRun} 的孤儿清理）时，没有任何 worker 会收到中止广播——
   * 直接写 `run_aborted`、status 置为 aborted、consumed_seq 至少推进到触发消息，返回 true。
   * 不是孤儿（有人在执行或即将执行）或运行已结束 → 返回 false，由调用方走广播中止。
   */
  async abortIfOrphaned(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
  ): Promise<boolean> {
    if ((await this.lock.holder(conversationId)) !== null) return false;
    const toSeq = await this.db.transaction().execute(async (t) => {
      await t
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", conversationId)
        .forUpdate()
        .executeTakeFirst();
      const active = await this.activeRun(t, conversationId);
      if (!active || active.id !== runId) return null;
      if (!(await this.isOrphan(conversationId, active))) return null;
      this.log.warn("aborting orphaned run directly", { conversationId, runId });
      return finishRunIn(t, this.eventLog, {
        conversationId,
        runId,
        status: "aborted",
        consumed: null,
        event: { type: "run_aborted", payload: { byAccountId, reason: "user" } },
      });
    });
    if (toSeq === null) return false;
    await this.eventLog.notify(conversationId, toSeq);
    await this.dropCheckpoints(runId);
    return true;
  }

  /** 会话当前未结束的运行（调用方已持有会话行锁）。 */
  private activeRun(t: KernelTrx, conversationId: string): Promise<ActiveRunRow | undefined> {
    return t
      .selectFrom("runs")
      .select([
        "id",
        "status",
        "trigger_seq",
        "job_id",
        sql<boolean>`COALESCE(queued_at, created_at) < now() - make_interval(secs => ${ORPHAN_QUEUED_GRACE_SECONDS})`.as(
          "past_grace",
        ),
      ])
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ACTIVE_RUN_STATUSES)
      .executeTakeFirst();
  }

  /**
   * 未结束的运行是否已是孤儿（调用方已确认会话锁无人持有）：waiting → 否（等人处理，本来就没有任务，
   * 由人工决定或超时任务续跑）；queued 且仍在宽限期内 → 否（任务可能还没投递）；BullMQ 任务（续跑任务按
   * `runs.job_id`）仍存在 → 否；否则是。
   */
  private async isOrphan(conversationId: string, active: ActiveRunRow): Promise<boolean> {
    if (active.status === "waiting") return false;
    if (active.status === "queued" && !active.past_grace) return false;
    const jobId = active.job_id ?? runJobId(conversationId, Number(active.trigger_seq));
    const job = await this.getQueue().getJob(jobId);
    return !job;
  }

  /** 删除已结束运行的 checkpoint thread（失败只记日志）。 */
  private async dropCheckpoints(runId: string): Promise<void> {
    await this.checkpoints
      ?.deleteThread(runId)
      .catch((err) => this.log.warn("checkpoint delete failed", { runId, err }));
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
