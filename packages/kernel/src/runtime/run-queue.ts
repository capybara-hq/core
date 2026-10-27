import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql, type Transaction } from "kysely";
import { visibleTo } from "../agents/agents.service.js";
import type { EventLog } from "../conversations/event-log.js";
import { dispatchQueuedIn, pauseQueueWith } from "../conversations/queue.js";
import type { ConversationKind, KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import type { RunAbortDetail } from "./abort.js";
import type { KyselyCheckpointSaver } from "./checkpointer.js";
import type { ConversationLock } from "./conversation-lock.js";
import { finishRunIn, notifyFinished } from "./run-finish.js";

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

/** What an orphan repair does for a parent's sub-agents (wired by the kernel). */
export interface OrphanSubagents {
  /** `ToolPipeline.stopOpenAgentCalls`: the run's open `agent` call results, in `t`. */
  stopOpenCalls(t: KernelTrx, runId: string): Promise<{ fire: () => void }>;
  /** `stopChildren(runId, null)`: after the commit, its active children stop. */
  stopChildren(runId: string): Promise<unknown>;
}

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
  private readonly queues = new Map<string, Queue<RunJobData>>();
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
    /** Sub-agent cleanup when an orphan repair ends a parent run (sub-agents spec §12). */
    private readonly subagents?: OrphanSubagents,
  ) {}

  /**
   * The `beforeTerminal` of an orphan repair: writes the run's open `agent` call results in `t`;
   * `fire()` runs their observe hooks after the commit (review m1).
   */
  private stopOpenCalls(runId: string): {
    beforeTerminal?: (t: KernelTrx) => Promise<void>;
    fire: () => void;
  } {
    const sub = this.subagents;
    if (!sub) return { fire: () => {} };
    let fire = () => {};
    return {
      beforeTerminal: async (t) => {
        fire = (await sub.stopOpenCalls(t, runId)).fire;
      },
      fire: () => fire(),
    };
  }

  /** The BullMQ queue `name` (default: conversation runs); both share one connection. */
  private getQueue(name: string = RUN_QUEUE_NAME): Queue<RunJobData> {
    if (this.closed) throw new Error("run queue is closed");
    let queue = this.queues.get(name);
    if (!queue) {
      this.conn ??= bullConnection(this.redisUrl, this.log);
      queue = new Queue<RunJobData>(name, { connection: this.conn });
      queue.on("error", (err) => this.log.error("run queue error", { err, queue: name }));
      this.queues.set(name, queue);
    }
    return queue;
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
    let dispatchedSeq: number | null = null;
    let dispatchedSwitch = false;
    let orphanStop: ReturnType<RunQueue["stopOpenCalls"]> | undefined;
    const created = await this.db.transaction().execute(async (t) => {
      const conv = await t
        .selectFrom("conversations")
        .select(["consumed_seq", "agent_id", "kind", "queue_paused", "account_id"])
        .where("id", "=", conversationId)
        .forUpdate()
        .executeTakeFirst();
      // 评测回放的隐藏对话：运行由评测 worker 在里面直接驱动（工具只回放记录），绝不为它起真实运行
      if (conv?.kind !== "chat") return null;
      let last = await t
        .selectFrom("conversation_events")
        .select(["seq", "payload"])
        .where("conversation_id", "=", conversationId)
        .where("type", "=", "user_message")
        .orderBy("seq", "desc")
        .limit(1)
        .executeTakeFirst();
      if (!last || Number(last.seq) <= Number(conv.consumed_seq)) {
        // Nothing unconsumed: the queue's head goes out when the conversation is idle (no active
        // run, which includes runs waiting for approval or an answer) and the queue is not paused.
        // Interjections are always unconsumed messages, so the queue never jumps ahead of them.
        if (conv.queue_paused || (await this.activeRun(t, conversationId))) return null;
        const owner = await t
          .selectFrom("agents")
          .select("deleted_at")
          .where("id", "=", conv.agent_id)
          .executeTakeFirstOrThrow();
        if (owner.deleted_at !== null) return null;
        const head = await t
          .selectFrom("conversation_queue")
          .select("id")
          .where("conversation_id", "=", conversationId)
          .limit(1)
          .executeTakeFirst();
        if (!head) return null;
        // A queued message may wait for hours: it goes out only while its author can still use
        // the conversation (active, a member, the agent visible to them; the isAccessible rule).
        // Otherwise the queue pauses instead of posting as someone who lost access.
        if (!(await authorCanSend(t, conversationId, conv.account_id))) {
          await pauseQueueWith(t, conversationId, "author_cannot_send");
          this.log.warn("queued message not sent: its author can no longer use the conversation", {
            conversationId,
          });
          return null;
        }
        const sent = await dispatchQueuedIn(t, this.eventLog, conversationId);
        if (!sent) return null;
        if ("paused" in sent) {
          this.log.warn("queued skill invocation not sent: the skill can no longer be invoked", {
            conversationId,
          });
          return null;
        }
        dispatchedSeq = sent.event.seq;
        dispatchedSwitch = sent.switched;
        last = { seq: String(sent.event.seq), payload: sent.event.payload };
      }
      const active = await this.activeRun(t, conversationId);
      if (active) {
        if (!(await this.isOrphan(conversationId, active, conv.kind))) return null;
        this.log.warn("marking orphaned run as failed", { conversationId, runId: active.id });
        orphanRunId = active.id;
        const stop = this.stopOpenCalls(active.id);
        orphanStop = stop;
        orphanSeq = await finishRunIn(t, this.eventLog, {
          conversationId,
          runId: active.id,
          status: "failed",
          consumed: null,
          ...(stop.beforeTerminal !== undefined && { beforeTerminal: stop.beforeTerminal }),
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
      // what is consumed now (an orphan's failure consumed up to its trigger)
      const consumedNow = Math.max(
        Number(conv.consumed_seq),
        orphanRunId !== null && active ? Number(active.trigger_seq) : 0,
      );
      // phase D run boundary: the first unconsumed fork invocation is the trigger of the run that
      // absorbs it (`forkBoundary`); later messages wait for the next run
      const fork = await t
        .selectFrom("conversation_events")
        .select(["seq", "payload"])
        .where("conversation_id", "=", conversationId)
        .where("type", "=", "user_message")
        .where("seq", ">", String(consumedNow))
        .where(sql<boolean>`payload -> 'skill' ->> 'mode' = 'fork'`)
        .orderBy("seq")
        .limit(1)
        .executeTakeFirst();
      const trigger = fork ?? last;
      // BullMQ 对重复的 jobId 静默忽略（add 返回的 Job 由调用方数据构造，看不出是否真的入队）：
      // 先显式查同一触发点的任务；仍存在（例如属于刚结束、尚未从队列移除的运行）就不插入 runs 行。
      const jobId = runJobId(conversationId, Number(trigger.seq));
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
          trigger_account_id: (trigger.payload as { authorAccountId: string }).authorAccountId,
          trigger_seq: Number(trigger.seq),
        })
        .execute();
      return { runId, jobId };
    });
    if (orphanSeq !== null) {
      await notifyFinished(this.eventLog, conversationId, orphanSeq, "failed");
      orphanStop?.fire();
    }
    if (dispatchedSeq !== null) {
      await this.eventLog.notify(conversationId, dispatchedSeq);
      await this.eventLog.publishChanged(conversationId, "queue");
      if (dispatchedSwitch) await this.eventLog.publishChanged(conversationId, "selection");
    }
    if (orphanRunId !== null) {
      await this.dropCheckpoints(orphanRunId);
      // a lost parent stops its children now, not at the next sweep (review m2)
      if (orphanSeq !== null) {
        await this.subagents?.stopChildren(orphanRunId).catch((err) =>
          this.log.error("cannot stop the sub-agents of an orphaned run", {
            runId: orphanRunId,
            err,
          }),
        );
      }
    }
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

  /**
   * Enqueues a run job under the caller's job id (resumes, dispatches, repairs), with the same
   * options as {@link ensureRun}. The queue follows the conversation's kind (a sub-agent's runs go
   * to {@link SUBAGENT_RUN_QUEUE_NAME}); pass `kind` when the caller knows it, else it is read.
   */
  async enqueue(data: RunJobData, jobId: string, kind?: ConversationKind): Promise<void> {
    const k =
      kind ??
      (
        await this.db
          .selectFrom("conversations")
          .select("kind")
          .where("id", "=", data.conversationId)
          .executeTakeFirst()
      )?.kind ??
      "chat";
    await this.getQueue(runQueueNameFor(k)).add("run", data, {
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
    detail?: RunAbortDetail,
  ): Promise<boolean> {
    if ((await this.lock.holder(conversationId)) !== null) return false;
    const stop = this.stopOpenCalls(runId);
    const toSeq = await this.db.transaction().execute(async (t) => {
      const conv = await t
        .selectFrom("conversations")
        .select("kind")
        .where("id", "=", conversationId)
        .forUpdate()
        .executeTakeFirst();
      const active = await this.activeRun(t, conversationId);
      if (!conv || !active || active.id !== runId) return null;
      if (!(await this.isOrphan(conversationId, active, conv.kind))) return null;
      this.log.warn("aborting orphaned run directly", { conversationId, runId });
      return finishRunIn(t, this.eventLog, {
        conversationId,
        runId,
        status: "aborted",
        consumed: null,
        ...(stop.beforeTerminal !== undefined && { beforeTerminal: stop.beforeTerminal }),
        event: {
          type: "run_aborted",
          payload: { byAccountId, reason: "user", ...(detail !== undefined && { detail }) },
        },
      });
    });
    if (toSeq === null) return false;
    await notifyFinished(this.eventLog, conversationId, toSeq, "aborted");
    stop.fire();
    await this.dropCheckpoints(runId);
    return true;
  }

  /**
   * Repairs an orphaned run of a conversation nobody else repairs on demand (a sub-agent's: no
   * `ensureRun` ever runs for it; sub-agents spec §7.5), with the same orphan test as
   * {@link ensureRun}: the conversation lock is free, the run is still `queued` / `running`, its
   * job is gone, and a `queued` one is past the grace period.
   * - `queued` (the dispatch or resume committed, its enqueue was lost) → enqueued again under its
   *   own job id (`runs.job_id`, else the trigger's), so concurrent repairs on several replicas
   *   still leave one job: `"requeued"`;
   * - `running` (its worker died without a terminal state and BullMQ dropped the job) → marked
   *   failed `run.orphaned`; the caller reports it to the parent: `"failed"`.
   * Not an orphan, or already finished → null.
   */
  async repairOrphan(conversationId: string, runId: string): Promise<"requeued" | "failed" | null> {
    if ((await this.lock.holder(conversationId)) !== null) return null;
    const r = await this.db.transaction().execute(async (t) => {
      const conv = await t
        .selectFrom("conversations")
        .select("kind")
        .where("id", "=", conversationId)
        .forUpdate()
        .executeTakeFirst();
      const active = await this.activeRun(t, conversationId);
      if (!conv || !active || active.id !== runId) return null;
      if (!(await this.isOrphan(conversationId, active, conv.kind))) return null;
      if (active.status === "queued") {
        const jobId = active.job_id ?? runJobId(conversationId, Number(active.trigger_seq));
        return { kind: "requeued" as const, jobId, convKind: conv.kind };
      }
      this.log.warn("marking orphaned run as failed", { conversationId, runId });
      const seq = await finishRunIn(t, this.eventLog, {
        conversationId,
        runId,
        status: "failed",
        consumed: null,
        event: {
          type: "run_failed",
          payload: {
            error: { code: "run.orphaned", message: "The run was lost and will not continue" },
          },
        },
      });
      return { kind: "failed" as const, seq };
    });
    if (!r) return null;
    if (r.kind === "requeued") {
      await this.enqueue({ runId, conversationId }, r.jobId, r.convKind);
      return "requeued";
    }
    if (r.seq !== null) await notifyFinished(this.eventLog, conversationId, r.seq, "failed");
    await this.dropCheckpoints(runId);
    return "failed";
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
  private async isOrphan(
    conversationId: string,
    active: ActiveRunRow,
    kind: ConversationKind,
  ): Promise<boolean> {
    if (active.status === "waiting") return false;
    if (active.status === "queued" && !active.past_grace) return false;
    const jobId = active.job_id ?? runJobId(conversationId, Number(active.trigger_seq));
    const job = await this.getQueue(runQueueNameFor(kind)).getJob(jobId);
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
    const qs = [...this.queues.values()];
    const c = this.conn;
    this.queues.clear();
    this.conn = undefined;
    await Promise.all(qs.map((q) => q.close().catch(() => {})));
    if (c) await c.quit().catch(() => c.disconnect());
  }
}

/** The conversation's owner is active and can still see its agent (`isAccessible`'s rule). */
async function authorCanSend(
  t: Transaction<KernelDatabase>,
  conversationId: string,
  accountId: string,
): Promise<boolean> {
  const row = await t
    .selectFrom("conversations")
    .select("conversations.id")
    .where("conversations.id", "=", conversationId)
    .where((eb) =>
      eb.and([
        eb.exists(
          eb
            .selectFrom("accounts")
            .select(sql`1`.as("one"))
            .where("accounts.id", "=", accountId)
            .where("accounts.status", "=", "active"),
        ),
        eb.exists(
          eb
            .selectFrom("agents")
            .select(sql`1`.as("one"))
            .whereRef("agents.id", "=", "conversations.agent_id")
            .where("agents.deleted_at", "is", null)
            .where(visibleTo(accountId)),
        ),
      ]),
    )
    .executeTakeFirst();
  return row !== undefined;
}
