import { randomUUID } from "node:crypto";
import {
  type ChannelTarget,
  type FormAnswer,
  type InputForm,
  isChannelSendError,
  type Logger,
  type OutboundMessage,
} from "@capybara-hq/plugin-sdk";
import { DelayedError, type Job, Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { KernelConfig } from "../config/schema.js";
import {
  type ConversationBusMessage,
  conversationTopic,
  type EventLog,
} from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { ConversationLock, type Lease } from "../runtime/conversation-lock.js";
import { bullConnection } from "../runtime/run-queue.js";
import type { StreamBus } from "../runtime/stream.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import type { QuestionsService } from "../tools/questions.service.js";
import {
  approvalCard,
  cardMessage,
  connectUrl,
  conversationUrl,
  questionCard,
  webBase,
} from "./cards.js";
import type { ChannelConnections, ChannelOutboundSession } from "./connections.service.js";
import type { ChannelOutboundScheduler } from "./inbound.js";
import { type ChannelLocale, phrase } from "./phrases.js";

/** 渠道出站投递队列（不含 `:`），只在 worker 角色上消费。 */
export const CHANNEL_QUEUE_NAME = "cap-kernel-channels";
/** 投递任务名。 */
export const DELIVER_JOB = "deliver";
/** 投递任务 id（不含 `:`）：同一会话、同一日志位置只排一个任务。 */
export const deliverJobId = (conversationId: string, seq: number) =>
  `deliver-${conversationId}-${seq}`;
/** 按会话互斥的投递锁（Redis 键前缀；值为任务实例 token，TTL = `runtime.jobLockMs`）。 */
export const DELIVER_LOCK_PREFIX = "capk:channel-deliver:";

/** 草稿更新的最小间隔（毫秒）。 */
export const DRAFT_INTERVAL_MS = 1000;
/** 没有新消息时多久复核一次（是否该结束、是否有待刷新的草稿）。 */
const IDLE_POLL_MS = 500;
/** 投递锁被他人持有时，任务推迟多久再试。 */
const LOCK_BUSY_DELAY_MS = 1000;
/** 可重试失败（限流、5xx、网络、超时）的总尝试次数。 */
export const DELIVER_ATTEMPTS = 8;
/** 退避：未给出建议等待时长时 `min(上限, 基数 · 2^(n-1))`。 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** 补读事件的分页大小。 */
const PAGE = 200;
/** `last_error` 的最大长度（同渠道选主）。 */
const MAX_ERROR_CHARS = 1000;
/** 同时处理的投递任务数（任务大部分时间在等事件）。 */
const CONCURRENCY = 20;

interface DeliverJobData {
  conversationId: string;
}

/** 可重试的投递失败：带已打码的说明与平台建议的等待时长，供退避策略与最后一次失败时记录。 */
class RetryableDeliveryError extends Error {
  override name = "RetryableDeliveryError";
  constructor(
    readonly connectionId: string,
    message: string,
    readonly retryAfterMs: number | undefined,
  ) {
    super(message);
  }
}

/** 投递进度被别人推进了（投递锁丢失后另一实例接手）：本实例立刻停止。 */
class DeliveryLostError extends Error {
  override name = "DeliveryLostError";
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function isBusMessage(m: unknown): m is ConversationBusMessage {
  if (typeof m !== "object" || m === null) return false;
  const k = (m as { kind?: unknown }).kind;
  if (k === "events") return typeof (m as { toSeq?: unknown }).toSeq === "number";
  return k === "delta" && typeof (m as { runId?: unknown }).runId === "string";
}

/** BullMQ 退避：平台给了等待时长就用它，否则指数退避。 */
export function deliverBackoff(attemptsMade: number, err?: Error): number {
  if (err instanceof RetryableDeliveryError && err.retryAfterMs !== undefined) {
    return Math.min(BACKOFF_MAX_MS, Math.max(0, err.retryAfterMs));
  }
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1));
}

export interface ChannelOutboundDeps {
  db: KernelDb;
  redis: Redis;
  redisUrl: string;
  bus: StreamBus;
  eventLog: Pick<EventLog, "readAfter">;
  connections: Pick<ChannelConnections, "outbound">;
  approvals: Pick<ApprovalsService, "describe">;
  questions: Pick<QuestionsService, "forCall">;
  config: () => KernelConfig;
  log: Pick<Logger, "error" | "warn" | "info">;
}

/**
 * 渠道出站投递：把会话日志里 `channel_deliveries.last_seq` 之后的内容按序投到 IM。
 * - 生产方（任意角色）：`enqueue(conversationId)` 投递 `deliver-<会话>-<当前 seq>` 任务（会话没有投递目标时什么都不做）；
 * - Worker（只在 worker 角色）：每个任务先取按会话互斥的投递锁（被占则推迟重试），订阅 `conv.<id>` 后补读日志，
 *   直到运行进入 waiting / 终态且日志读完才结束。崩溃后 BullMQ stalled 机制把任务交给其他副本，从 `last_seq` 续投；
 *   每投递一个事件就在同一事务里推进 `last_seq` 并记下 IM 消息 id（草稿 id、卡片消息 id），已投递的不会重发。
 * 状态全部在 PG / Redis；进程内只有本任务自己的订阅、草稿节流时刻与等待定时器（本进程持有的资源）。
 */
export class ChannelOutbound implements ChannelOutboundScheduler {
  private queue: Queue<DeliverJobData> | undefined;
  private queueConn: Redis | undefined;
  private worker: Worker<DeliverJobData> | undefined;
  private workerConn: Redis | undefined;
  private closed = false;
  /** 停机：进行中的任务在下一个检查点交还队列（由其他副本续投）。 */
  private readonly stopping = new AbortController();
  private readonly lock: ConversationLock;

  constructor(private readonly d: ChannelOutboundDeps) {
    this.lock = new ConversationLock(d.redis, d.log, DELIVER_LOCK_PREFIX);
  }

  /** 会话有 IM 投递目标时投递一个出站任务（同一日志位置重复调用只排一个）。 */
  async enqueue(conversationId: string): Promise<void> {
    const row = await this.d.db
      .selectFrom("channel_deliveries")
      .innerJoin("conversations", "conversations.id", "channel_deliveries.conversation_id")
      .select("conversations.last_seq")
      .where("channel_deliveries.conversation_id", "=", conversationId)
      .executeTakeFirst();
    if (!row) return;
    await this.getQueue().add(
      DELIVER_JOB,
      { conversationId },
      {
        jobId: deliverJobId(conversationId, Number(row.last_seq)),
        attempts: DELIVER_ATTEMPTS,
        backoff: { type: "deliver" },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /** 启动 Worker（只在含 `worker` 角色的进程）。任务锁与 stalled 检测沿用运行队列的配置。 */
  startWorker(): void {
    if (this.worker || this.closed) return;
    const { jobLockMs, stalledIntervalMs } = this.d.config().runtime;
    this.workerConn = bullConnection(this.d.redisUrl, this.d.log);
    this.worker = new Worker<DeliverJobData>(
      CHANNEL_QUEUE_NAME,
      (job, token) => this.process(job, token),
      {
        connection: this.workerConn,
        concurrency: CONCURRENCY,
        lockDuration: jobLockMs,
        stalledInterval: stalledIntervalMs,
        maxStalledCount: 3,
        settings: { backoffStrategy: (n, _type, err) => deliverBackoff(n, err) },
      },
    );
    this.worker.on("error", (err) => this.d.log.error("channel outbound worker error", { err }));
    this.worker.on("failed", (job, err) => {
      if (err instanceof DelayedError || err.name === "DelayedError") return;
      this.d.log.warn("channel delivery attempt failed", { jobId: job?.id, error: err.message });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    const w = this.worker;
    const q = this.queue;
    this.worker = undefined;
    this.queue = undefined;
    await w?.close().catch(() => {});
    await q?.close().catch(() => {});
    for (const c of [this.workerConn, this.queueConn]) {
      if (c) await c.quit().catch(() => c.disconnect());
    }
    this.workerConn = undefined;
    this.queueConn = undefined;
  }

  private getQueue(): Queue<DeliverJobData> {
    if (this.closed) throw new Error("channel outbound queue is closed");
    if (!this.queue) {
      this.queueConn = bullConnection(this.d.redisUrl, this.d.log);
      this.queue = new Queue<DeliverJobData>(CHANNEL_QUEUE_NAME, { connection: this.queueConn });
      this.queue.on("error", (err) => this.d.log.error("channel outbound queue error", { err }));
    }
    return this.queue;
  }

  private async requeue(job: Job, token: string | undefined, delayMs: number): Promise<never> {
    await job.moveToDelayed(Date.now() + delayMs, token);
    throw new DelayedError();
  }

  private async process(job: Job<DeliverJobData>, token: string | undefined): Promise<void> {
    const { conversationId } = job.data;
    if (this.stopping.signal.aborted) return this.requeue(job, token, 0);
    const lease = await this.lock.acquire(
      conversationId,
      `${job.id ?? "job"}.${randomUUID()}`,
      this.d.config().runtime.jobLockMs,
    );
    if (!lease) return this.requeue(job, token, LOCK_BUSY_DELAY_MS);
    let outcome: DeliveryOutcome;
    try {
      outcome = await new Delivery(this.d, conversationId, lease, this.stopping.signal).run();
    } catch (err) {
      if (err instanceof RetryableDeliveryError) {
        const last = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (last) await this.recordError(err.connectionId, err.message);
      }
      throw err;
    } finally {
      await lease
        .release()
        .catch((err) =>
          this.d.log.warn("cannot release channel delivery lock", { conversationId, err }),
        );
    }
    if (outcome.kind === "shutdown") return this.requeue(job, token, 0);
    if (outcome.kind === "failed") await this.recordError(outcome.connectionId, outcome.message);
  }

  /** 不可重试（或重试用尽）的发送失败：记连接 `last_error`（已打码），本会话本轮投递停止。 */
  private async recordError(connectionId: string, message: string): Promise<void> {
    const text = `delivery failed: ${message}`.slice(0, MAX_ERROR_CHARS);
    this.d.log.warn("channel delivery stopped", { connectionId, error: text });
    await this.d.db
      .updateTable("channel_connections")
      .set({ last_error: text })
      .where("id", "=", connectionId)
      .execute()
      .catch((err) => this.d.log.warn("cannot record channel delivery error", { err }));
  }
}

type DeliveryOutcome =
  | { kind: "done" }
  | { kind: "shutdown" }
  | { kind: "failed"; connectionId: string; message: string };

/** 一个步骤正在流式输出的文本（只在从头收到时才发草稿）。 */
interface StreamingText {
  key: string;
  text: string;
  /** 从该步本次尝试的第一个字符起完整收到。 */
  complete: boolean;
}

/** 一次投递任务（本进程持有）：订阅、补读、草稿节流。 */
class Delivery {
  private readonly inbox: ConversationBusMessage[] = [];
  private wake: (() => void) | undefined;
  private session!: ChannelOutboundSession;
  private target!: ChannelTarget;
  private locale: ChannelLocale = "en";
  private base: string | undefined;
  /** 已处理到的事件 seq（内存）与已写入 PG 的 seq。 */
  private seen = 0;
  private persisted = 0;
  /** 当前草稿消息 id（PG 里的 `draft_message_id`）与它所属的步骤（从 PG 读出的草稿不知道步骤）。 */
  private draftId: string | null = null;
  private draftKey: string | undefined;
  private lastDraftAt = 0;
  private streaming: StreamingText | undefined;
  private dirty = false;
  /** 已定稿的步骤：之后到达的增量丢弃。 */
  private readonly finalized = new Set<string>();

  constructor(
    private readonly d: ChannelOutboundDeps,
    private readonly conversationId: string,
    private readonly lease: Lease,
    private readonly stopping: AbortSignal,
  ) {}

  async run(): Promise<DeliveryOutcome> {
    const row = await this.d.db
      .selectFrom("channel_deliveries")
      .select(["connection_id", "target", "last_seq", "draft_message_id"])
      .where("conversation_id", "=", this.conversationId)
      .executeTakeFirst();
    if (!row) return { kind: "done" };
    // 先订阅再补读：两者之间提交的事件不会漏掉
    const unsubscribe = await this.d.bus.subscribe(conversationTopic(this.conversationId), (m) => {
      if (!isBusMessage(m)) return;
      this.inbox.push(m);
      this.wake?.();
    });
    try {
      try {
        this.session = await this.d.connections.outbound(row.connection_id);
      } catch (err) {
        // 连接已删除 / 插件未启用或已卸载 / 配置不再合法：没有可投递的地方
        if (err instanceof ApiError) {
          this.d.log.warn("channel delivery skipped", {
            conversationId: this.conversationId,
            code: err.code,
          });
          return { kind: "done" };
        }
        throw err;
      }
      if (this.session.row.status !== "active") return { kind: "done" };
      this.target = row.target as ChannelTarget;
      this.seen = Number(row.last_seq);
      this.persisted = this.seen;
      this.draftId = row.draft_message_id;
      this.locale = (await readOrgSettings(this.d.db, this.session.row.orgId)).locale;
      this.base = webBase(this.d.config().http.publicUrl);
      return await this.loop();
    } catch (err) {
      if (err instanceof DeliveryLostError) return { kind: "done" };
      if (isChannelSendError(err) && !err.retryable) {
        return {
          kind: "failed",
          connectionId: row.connection_id,
          message: this.redact(errMsg(err)),
        };
      }
      if (this.session === undefined) throw err;
      throw new RetryableDeliveryError(
        row.connection_id,
        this.redact(errMsg(err)),
        isChannelSendError(err) ? err.retryAfterMs : undefined,
      );
    } finally {
      await unsubscribe().catch((err) =>
        this.d.log.warn("channel delivery unsubscribe failed", { err }),
      );
    }
  }

  private redact(s: string): string {
    return this.session ? this.session.redact(s) : s;
  }

  private async loop(): Promise<DeliveryOutcome> {
    let needCatchUp = true;
    for (;;) {
      if (this.lease.lost) return { kind: "done" };
      if (this.stopping.aborted) return { kind: "shutdown" };
      if (needCatchUp) {
        await this.catchUp();
        needCatchUp = false;
      }
      while (this.inbox.length > 0) {
        if (this.lease.lost) return { kind: "done" };
        const m = this.inbox.shift() as ConversationBusMessage;
        if (m.kind === "events") {
          if (m.toSeq > this.seen) await this.catchUp();
        } else {
          this.onDelta(m);
        }
      }
      await this.flushDraft();
      const woke = await this.waitWake(IDLE_POLL_MS);
      if (woke) continue;
      needCatchUp = true;
      if (await this.idle()) {
        await this.catchUp();
        needCatchUp = false;
        if (this.inbox.length === 0 && (await this.idle())) return { kind: "done" };
      }
    }
  }

  /** 运行已进入 waiting / 终态（没有 queued / running 的运行），且日志已读完。 */
  private async idle(): Promise<boolean> {
    const active = await this.d.db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", this.conversationId)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (active) return false;
    const conv = await this.d.db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", this.conversationId)
      .executeTakeFirst();
    return !conv || Number(conv.last_seq) <= this.seen;
  }

  private waitWake(ms: number): Promise<boolean> {
    if (this.inbox.length > 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const done = (v: boolean) => {
        clearTimeout(timer);
        this.stopping.removeEventListener("abort", onAbort);
        this.wake = undefined;
        resolve(v);
      };
      const onAbort = () => done(false);
      const timer = setTimeout(() => done(false), ms);
      this.wake = () => done(true);
      this.stopping.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** 读 `seen` 之后的全部事件并逐个投递；只是跳过的事件最后统一推进一次进度。 */
  private async catchUp(): Promise<void> {
    for (;;) {
      const evs = await this.d.eventLog.readAfter(this.conversationId, this.seen, PAGE);
      for (const e of evs) {
        if (e.seq <= this.seen) continue;
        if (this.lease.lost) throw new DeliveryLostError();
        await this.handle(e);
        this.seen = e.seq;
      }
      if (evs.length < PAGE) break;
    }
    if (this.seen > this.persisted) await this.advance(this.seen);
  }

  /**
   * 推进 `last_seq`（同一事务记下草稿 / 卡片消息 id）。以「仍是我上次写入的值」为条件：
   * 被别人推进过（投递锁丢失后另一实例接手）就停止，不再重复发送。
   */
  private async advance(
    seq: number,
    opts: {
      draft?: string | null;
      card?: { kind: "approval" | "question"; id: string; messageId: string };
    } = {},
  ): Promise<void> {
    await this.d.db.transaction().execute(async (t) => {
      const r = await t
        .updateTable("channel_deliveries")
        .set({
          last_seq: String(seq),
          ...(opts.draft !== undefined && { draft_message_id: opts.draft }),
          updated_at: new Date(),
        })
        .where("conversation_id", "=", this.conversationId)
        .where("last_seq", "=", String(this.persisted))
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) throw new DeliveryLostError();
      if (opts.card) {
        await t
          .insertInto("channel_card_messages")
          .values({
            conversation_id: this.conversationId,
            connection_id: this.session.row.id,
            card_kind: opts.card.kind,
            card_id: opts.card.id,
            message_id: opts.card.messageId,
            target: JSON.stringify(this.target),
          })
          .onConflict((oc) =>
            oc.columns(["conversation_id", "connection_id", "card_kind", "card_id"]).doUpdateSet({
              message_id: opts.card?.messageId as string,
              target: JSON.stringify(this.target),
            }),
          )
          .execute();
      }
    });
    this.persisted = seq;
    if (opts.draft !== undefined) {
      this.draftId = opts.draft;
      if (opts.draft === null) this.draftKey = undefined;
    }
  }

  private send(message: OutboundMessage): Promise<{ messageId: string }> {
    return this.session.send(this.target, message);
  }

  private async handle(e: ConversationEvent): Promise<void> {
    switch (e.type) {
      case "assistant_message":
        return this.finalize(e.runId, e.payload.step, e.payload.content, e.seq);
      case "approval_requested": {
        if (this.base === undefined) {
          await this.send({ text: phrase("handleOnWeb", this.locale) });
          return this.advance(e.seq);
        }
        const card = await approvalCard(this.d, e.payload.approvalId, this.base, this.locale);
        if (!card) return;
        const { messageId } = await this.send(cardMessage(card.title, card));
        return this.advance(e.seq, { card: { kind: "approval", id: card.id, messageId } });
      }
      case "question_asked": {
        if (this.base === undefined) {
          await this.send({ text: phrase("handleOnWeb", this.locale) });
          return this.advance(e.seq);
        }
        const card = questionCard(
          e.payload.questionId,
          e.payload.form as InputForm,
          "pending",
          conversationUrl(this.base, this.conversationId),
        );
        const { messageId } = await this.send(
          cardMessage(phrase("questionTitle", this.locale), card),
        );
        return this.advance(e.seq, { card: { kind: "question", id: card.id, messageId } });
      }
      case "connection_required": {
        const text = phrase("connectTitle", this.locale);
        await this.send(
          this.base === undefined
            ? { text: phrase("handleOnWeb", this.locale) }
            : cardMessage(text, {
                kind: "connect",
                appName: e.payload.appName,
                url: connectUrl(this.base, e.payload.appId),
              }),
        );
        return this.advance(e.seq);
      }
      case "approval_decided": {
        const at = await this.cardMessageOf("approval", e.payload.approvalId);
        if (!at || this.base === undefined) return;
        const card = await approvalCard(this.d, e.payload.approvalId, this.base, this.locale);
        if (!card) return;
        await this.replaceCard(at, cardMessage(card.title, card));
        return this.advance(e.seq);
      }
      case "question_answered": {
        const at = await this.cardMessageOf("question", e.payload.questionId);
        if (!at || this.base === undefined || e.runId === null) return;
        const q = (await this.d.questions.forCall(e.runId, e.payload.callId)).find(
          (x) => x.id === e.payload.questionId,
        );
        if (!q) return;
        const card = questionCard(
          q.id,
          q.form,
          e.payload.outcome,
          conversationUrl(this.base, this.conversationId),
          e.payload.answer as FormAnswer | null,
        );
        await this.replaceCard(at, cardMessage(phrase("questionTitle", this.locale), card));
        return this.advance(e.seq);
      }
      case "run_failed":
        await this.send({ text: phrase("runFailed", this.locale) });
        return this.advance(e.seq);
      default:
        return;
    }
  }

  /** 已发出的卡片消息；不是本连接发的（或在投递目标建立之前）返回 undefined。 */
  private async cardMessageOf(
    kind: "approval" | "question",
    id: string,
  ): Promise<{ messageId: string; target: ChannelTarget } | undefined> {
    const r = await this.d.db
      .selectFrom("channel_card_messages")
      .select(["message_id", "target"])
      .where("conversation_id", "=", this.conversationId)
      .where("connection_id", "=", this.session.row.id)
      .where("card_kind", "=", kind)
      .where("card_id", "=", id)
      .executeTakeFirst();
    return r && { messageId: r.message_id, target: r.target as ChannelTarget };
  }

  /** 更新卡片状态；不能编辑的渠道另发一条带新状态的卡片。 */
  private async replaceCard(
    at: { messageId: string; target: ChannelTarget },
    message: OutboundMessage,
  ): Promise<void> {
    if (this.session.features.edit) await this.session.update(at.target, at.messageId, message);
    else await this.session.send(at.target, message);
  }

  /** `assistant_message`：以完整文本定稿（更新草稿或新发）；不发送 thinking。 */
  private async finalize(
    runId: string | null,
    step: number,
    content: { type: string; text?: string }[],
    seq: number,
  ): Promise<void> {
    const key = `${runId}:${step}`;
    this.finalized.add(key);
    if (this.streaming?.key === key) {
      this.streaming = undefined;
      this.dirty = false;
    }
    const text = content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    const useDraft =
      this.draftId !== null &&
      this.session.features.edit &&
      (this.draftKey === undefined || this.draftKey === key);
    if (text.trim() === "") {
      if (useDraft) await this.advance(seq, { draft: null });
      return;
    }
    if (useDraft) await this.session.update(this.target, this.draftId as string, { text });
    else await this.send({ text });
    await this.advance(seq, { draft: null });
  }

  /** 流式增量：只累积本步从头收到的文本（`offset` 对得上），增量本身不进日志、不推进进度。 */
  private onDelta(m: Extract<ConversationBusMessage, { kind: "delta" }>): void {
    if (!this.session.features.edit) return;
    const key = `${m.runId}:${m.step}`;
    if (this.finalized.has(key)) return;
    if (m.delta === "step_reset") {
      // 该步重试：此前的文本作废，下一次尝试从 offset 0 重新开始
      this.streaming = { key, text: "", complete: false };
      return;
    }
    if (m.delta !== "text" || m.text === undefined) return;
    const s = this.streaming?.key === key ? this.streaming : undefined;
    if (m.offset === 0) {
      this.streaming = { key, text: m.text, complete: true };
    } else if (s?.complete && m.offset === s.text.length) {
      s.text += m.text;
    } else {
      this.streaming = { key, text: s?.text ?? "", complete: false };
      return;
    }
    this.dirty = true;
  }

  /** 首次有文本时发草稿（先把消息 id 写进 PG 再继续），之后至多每秒更新一次。 */
  private async flushDraft(): Promise<void> {
    const s = this.streaming;
    if (!s?.complete || !this.dirty || s.text.trim() === "") return;
    if (this.draftId !== null && this.draftKey !== undefined && this.draftKey !== s.key) return;
    const now = Date.now();
    if (this.draftId === null) {
      const { messageId } = await this.send({ text: s.text });
      const r = await this.d.db
        .updateTable("channel_deliveries")
        .set({ draft_message_id: messageId, updated_at: new Date() })
        .where("conversation_id", "=", this.conversationId)
        .where("last_seq", "=", String(this.persisted))
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) throw new DeliveryLostError();
      this.draftId = messageId;
      this.draftKey = s.key;
    } else {
      if (now - this.lastDraftAt < DRAFT_INTERVAL_MS) return;
      await this.session.update(this.target, this.draftId, { text: s.text });
      this.draftKey = s.key;
    }
    this.lastDraftAt = now;
    this.dirty = false;
  }
}
