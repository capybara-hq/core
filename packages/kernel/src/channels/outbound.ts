import { createHash, randomUUID } from "node:crypto";
import {
  type ChannelTarget,
  type FormAnswer,
  type InboundEvent,
  type InputForm,
  isChannelSendError,
  type Logger,
  type OutboundMessage,
} from "@capybara-hq/plugin-sdk";
import { DelayedError, type Job, Queue, UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { sql } from "kysely";
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

/** 渠道队列（出站投递与入站任务，不含 `:`），只在 worker 角色上消费。 */
export const CHANNEL_QUEUE_NAME = "cap-kernel-channels";
/** 投递任务名。 */
export const DELIVER_JOB = "deliver";
/** 投递任务 id（不含 `:`）：同一会话、同一日志位置只排一个任务。 */
export const deliverJobId = (conversationId: string, seq: number) =>
  `deliver-${conversationId}-${seq}`;
/**
 * 结束后复核排的任务 id：每次唯一（带随机后缀，不含 `:`）。不能复用 `deliver-<会话>-<seq>`——同 id 的任务
 * 可能正因锁被占而即将直接结束，BullMQ 会把新任务去重进它，于是没人投递。
 */
export const followUpJobId = (conversationId: string, seq: number) =>
  `deliver-${conversationId}-${seq}-f${randomUUID().slice(0, 8)}`;

/**
 * 发给插件的幂等键（Ruling A15）：把逻辑键（如 `<会话>-<seq>`）做 sha256，取 base64url 的前 32 个字符——
 * 稳定、只含 `[A-Za-z0-9_-]`，满足常见平台的长度限制。
 */
export function idempotencyKey(raw: string): string {
  return createHash("sha256").update(raw).digest("base64url").slice(0, 32);
}

/**
 * 投递锁被占时怎么办：读不到持有者（刚被释放）→ 再取一次；是自己上一次（已崩溃、被 stalled 重新投递）的尝试 →
 * 推迟重试等它过期；别的任务 → 直接结束（它会读到新事件，结束时还会复核）。
 */
export function busyLockAction(holder: string | null, owner: string): "retry" | "requeue" | "drop" {
  if (holder === null) return "retry";
  return holder.startsWith(owner) ? "requeue" : "drop";
}

/** 草稿收尾的方式：运行失败加失败说明、中止加「已停止」，其余不改草稿内容。 */
export type DraftClosing = "failed" | "stopped" | "none";

/**
 * 收尾草稿时写入的文本：`failed` / `stopped` 为「已有文本 + 空行 + 说明」（不知道已有文本时只有说明）；
 * `none` 返回 undefined（保留草稿原样，只清掉草稿 id）。
 */
export function closingText(
  prior: string | undefined,
  how: DraftClosing,
  locale: ChannelLocale,
): string | undefined {
  if (how === "none") return undefined;
  const marker = phrase(how === "failed" ? "runFailed" : "runStopped", locale);
  return prior?.trim() ? `${prior}\n\n${marker}` : marker;
}

/** 按会话互斥的投递锁（Redis 键前缀；值为 `<job id>.<随机>`，TTL = `runtime.jobLockMs`）。 */
export const DELIVER_LOCK_PREFIX = "capk:channel-deliver:";

/** 草稿更新的最小间隔（毫秒）；渠道声明了更大的 `features.minEditIntervalMs` 时取后者。 */
export const DRAFT_INTERVAL_MS = 1000;
/** 没有新消息时多久复核一次（是否该结束、是否有待刷新的草稿）。 */
const IDLE_POLL_MS = 500;
/** 投递锁丢失 / 被自己上一次（已崩溃的）尝试占着时，任务推迟多久再试。 */
const LOCK_BUSY_DELAY_MS = 1000;
/** 本副本没有加载连接的插件时，任务推迟多久再试（滚动升级期间由有插件的副本接手）。 */
const PLUGIN_PENDING_DELAY_MS = 5000;
/** 插件一直没有在任何副本上加载：任务排进队列这么久之后放弃（之后的新事件会再排任务）。 */
const PLUGIN_PENDING_MAX_MS = 3_600_000;
/** 可重试失败（限流、5xx、网络、超时）的总尝试次数。 */
export const DELIVER_ATTEMPTS = 8;
/** 同一事件不可重试地失败这么多次后跳过它（Ruling A14）。 */
export const POISON_FAILURES = 3;
/** 退避：未给出建议等待时长时 `min(上限, 基数 · 2^(n-1))`。 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** 补读事件的分页大小。 */
const PAGE = 200;
/** `last_error` 的最大长度（同渠道选主）。 */
const MAX_ERROR_CHARS = 1000;

interface DeliverJobData {
  conversationId: string;
}

/** 入站任务（Ruling A21）：插件 `onEvent` 收到的事件，原样排进队列由 worker 处理。 */
interface InboundJobData {
  connectionId: string;
  event: InboundEvent;
}

type ChannelJobData = DeliverJobData | InboundJobData;

/** 入站任务名。 */
export const INBOUND_JOB = "inbound";
/**
 * BullMQ 优先级（数字越小越先）：入站任务先于出站投递任务——投递任务可能占着并发槽等输出，
 * 用户发来的消息不能排在它们后面。
 */
export const INBOUND_PRIORITY = 1;
export const DELIVER_PRIORITY = 10;
/** 入站任务的总尝试次数（处理失败由 BullMQ 指数退避重试：1s、2s、4s、8s）。 */
export const INBOUND_ATTEMPTS = 5;
const INBOUND_BACKOFF_MS = 1000;

/**
 * 入站消息的任务 id（不含 `:`）：`inbound-<连接>-<sha256(消息 id) 的 base64url 前 22 位>`。同一条消息只排一个任务
 * （已完成的任务保留一段时间，期间重复入队被 BullMQ 忽略）。
 */
export const inboundJobId = (connectionId: string, messageId: string) =>
  `inbound-${connectionId}-${createHash("sha256").update(messageId).digest("base64url").slice(0, 22)}`;

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

/** 投递进度被别人推进了（投递锁丢失后另一实例接手）：本实例立刻停止并交还任务。 */
class DeliveryLostError extends Error {
  override name = "DeliveryLostError";
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 编辑草稿被平台不可重试地拒绝（凭据失效、目标已不存在除外：那两种改发新消息同样会失败）。 */
const editRejected = (e: unknown): boolean =>
  isChannelSendError(e) && !e.retryable && e.reason !== "auth" && e.reason !== "target_gone";

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
  /** 入站任务的处理（worker 上执行 `ChannelInbound.handle`）；失败抛错由 BullMQ 重试。 */
  inbound?: (connectionId: string, e: InboundEvent) => Promise<void>;
}

/**
 * 渠道出站投递：把会话日志里 `channel_deliveries.last_seq` 之后的内容按序投到 IM。
 * - 生产方（任意角色）：`enqueue(conversationId)` 投递 `deliver-<会话>-<当前 seq>` 任务（会话没有投递目标时什么都不做）。
 *   内核在会话每次追加事件后都调用它（事件日志的 notify 钩子），运行开始时也调用。
 * - Worker（只在 worker 角色）：每个任务先取按会话互斥的投递锁，订阅 `conv.<id>` 后补读日志；运行进入 waiting /
 *   终态且日志读完，或追上后 `channels.deliveryIdleMs` 内没有新的总线消息，任务就结束（不长期占并发槽）。
 *   锁被别的任务持有 → 本任务直接结束：持有者会读到新事件，且它结束时（释放锁之后）复核日志是否有新内容，有就再排一个任务；
 *   锁被自己上一次（已崩溃的）尝试占着 → 推迟重试，等锁过期。
 *   崩溃后 BullMQ stalled 机制把任务交给其他副本，从 `last_seq` 续投；每投递一个事件就在同一事务里推进 `last_seq`
 *   并记下 IM 消息 id（草稿 id、卡片消息 id），已投递的不会重发。
 * 同一队列还承载入站任务（`inbound`，Ruling A21）：由 `enqueueInbound` 排入，worker 调用 `deps.inbound` 处理，
 * 失败按 BullMQ 指数退避重试。
 * 状态全部在 PG / Redis；进程内只有本任务自己的订阅、草稿节流时刻与等待定时器（本进程持有的资源）。
 */
export class ChannelOutbound implements ChannelOutboundScheduler {
  private queue: Queue<ChannelJobData> | undefined;
  private queueConn: Redis | undefined;
  private worker: Worker<ChannelJobData> | undefined;
  private workerConn: Redis | undefined;
  private closed = false;
  /** 停机：进行中的任务在下一个检查点交还队列（由其他副本续投）。 */
  private readonly stopping = new AbortController();
  private readonly lock: ConversationLock;

  constructor(private readonly d: ChannelOutboundDeps) {
    this.lock = new ConversationLock(d.redis, d.log, DELIVER_LOCK_PREFIX);
  }

  /** 会话有 IM 投递目标时投递一个出站任务（同一日志位置重复调用只排一个）；已关闭时什么都不做。 */
  async enqueue(conversationId: string, opts: { followUp?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    const row = await this.d.db
      .selectFrom("channel_deliveries")
      .innerJoin("conversations", "conversations.id", "channel_deliveries.conversation_id")
      .select("conversations.last_seq")
      .where("channel_deliveries.conversation_id", "=", conversationId)
      .executeTakeFirst();
    if (!row || this.closed) return;
    await this.getQueue().add(
      DELIVER_JOB,
      { conversationId },
      {
        jobId: opts.followUp
          ? followUpJobId(conversationId, Number(row.last_seq))
          : deliverJobId(conversationId, Number(row.last_seq)),
        attempts: DELIVER_ATTEMPTS,
        backoff: { type: "deliver" },
        priority: DELIVER_PRIORITY,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /**
   * 排一个入站任务（Ruling A21，同一队列 `cap-kernel-channels`）：处理失败按 {@link INBOUND_ATTEMPTS} 次指数退避重试。
   * 已关闭时抛错（调用方据此让插件不确认、由平台重投）。
   */
  async enqueueInbound(connectionId: string, event: InboundEvent, jobId: string): Promise<void> {
    await this.getQueue().add(
      INBOUND_JOB,
      { connectionId, event },
      {
        jobId,
        attempts: INBOUND_ATTEMPTS,
        priority: INBOUND_PRIORITY,
        backoff: { type: "exponential", delay: INBOUND_BACKOFF_MS },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    );
  }

  /**
   * 连接重新可投递（轮换了凭据 / 重新启用）：给该连接投递进度落后于会话日志的会话各排一个出站任务，
   * 补投停用或凭据失效期间落下的内容（不必等下一条消息）。
   */
  async resumeConnection(connectionId: string): Promise<void> {
    const rows = await this.d.db
      .selectFrom("channel_deliveries")
      .innerJoin("conversations", "conversations.id", "channel_deliveries.conversation_id")
      .select("channel_deliveries.conversation_id")
      .where("channel_deliveries.connection_id", "=", connectionId)
      .whereRef("channel_deliveries.last_seq", "<", "conversations.last_seq")
      .execute();
    for (const r of rows) await this.enqueue(r.conversation_id, { followUp: true });
  }

  /** 启动 Worker（只在含 `worker` 角色的进程）。任务锁与 stalled 检测沿用运行队列的配置。 */
  startWorker(): void {
    if (this.worker || this.closed) return;
    const { jobLockMs, stalledIntervalMs } = this.d.config().runtime;
    this.workerConn = bullConnection(this.d.redisUrl, this.d.log);
    this.worker = new Worker<ChannelJobData>(
      CHANNEL_QUEUE_NAME,
      (job, token) => this.process(job, token),
      {
        connection: this.workerConn,
        concurrency: this.d.config().channels.deliveryConcurrency,
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

  private getQueue(): Queue<ChannelJobData> {
    if (this.closed) throw new Error("channel outbound queue is closed");
    if (!this.queue) {
      this.queueConn = bullConnection(this.d.redisUrl, this.d.log);
      this.queue = new Queue<ChannelJobData>(CHANNEL_QUEUE_NAME, { connection: this.queueConn });
      this.queue.on("error", (err) => this.d.log.error("channel outbound queue error", { err }));
    }
    return this.queue;
  }

  private async requeue(job: Job, token: string | undefined, delayMs: number): Promise<never> {
    await job.moveToDelayed(Date.now() + delayMs, token);
    throw new DelayedError();
  }

  private async process(job: Job<ChannelJobData>, token: string | undefined): Promise<void> {
    if (this.stopping.signal.aborted) return this.requeue(job, token, 0);
    if (job.name === INBOUND_JOB) return this.processInbound(job as Job<InboundJobData>, token);
    return this.deliver(job as Job<DeliverJobData>, token);
  }

  /** 本副本没有加载连接的插件：推迟重试（不消耗重试次数），排队超过上限才放弃。 */
  private async pluginPending(job: Job, token: string | undefined, what: string): Promise<void> {
    if (Date.now() - job.timestamp > PLUGIN_PENDING_MAX_MS) {
      this.d.log.warn(`channel ${what} dropped: plugin not loaded on any replica in time`, {
        jobId: job.id,
      });
      return;
    }
    return this.requeue(job, token, PLUGIN_PENDING_DELAY_MS);
  }

  /**
   * 入站任务：失败抛出由 BullMQ 重试；插件在本副本未加载 → 推迟重试（同出站）；回复时插件报凭据失效 /
   * 目标已不存在 → 不重试（`UnrecoverableError`）。最后一次也失败时记错误日志（消息丢失，平台已确认过）。
   */
  private async processInbound(job: Job<InboundJobData>, token: string | undefined): Promise<void> {
    const { connectionId, event } = job.data;
    if (!this.d.inbound) throw new Error("channel inbound handler is not configured");
    try {
      await this.d.inbound(connectionId, event);
    } catch (err) {
      if (err instanceof ApiError && err.code === "plugin.not_found") {
        return this.pluginPending(job, token, "inbound event");
      }
      if (
        isChannelSendError(err) &&
        !err.retryable &&
        (err.reason === "auth" || err.reason === "target_gone")
      ) {
        this.d.log.warn("channel inbound reply failed permanently", {
          connectionId,
          type: event.type,
          reason: err.reason,
        });
        throw new UnrecoverableError(`inbound reply failed: ${err.reason}`);
      }
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        this.d.log.error("channel inbound event dropped after retries", {
          connectionId,
          type: event.type,
          err,
        });
      }
      throw err;
    }
  }

  private async deliver(job: Job<DeliverJobData>, token: string | undefined): Promise<void> {
    const { conversationId } = job.data;
    const owner = `${job.id ?? "job"}.`;
    const acquire = () =>
      this.lock.acquire(
        conversationId,
        `${owner}${randomUUID()}`,
        this.d.config().runtime.jobLockMs,
      );
    let lease = await acquire();
    if (!lease) {
      const action = busyLockAction(await this.lock.holder(conversationId), owner);
      if (action === "requeue") return this.requeue(job, token, LOCK_BUSY_DELAY_MS);
      if (action === "drop") return;
      lease = await acquire();
      // 再次被占：取到锁的那个任务会投递
      if (!lease) return;
    }
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
    if (outcome.error) await this.recordError(outcome.error.connectionId, outcome.error.message);
    switch (outcome.kind) {
      case "shutdown":
        return this.requeue(job, token, 0);
      case "lost":
        // 锁丢失 / 进度被别人推进：交还任务稍后再试（不当作完成，以免最后一段输出无人投递）
        return this.requeue(job, token, LOCK_BUSY_DELAY_MS);
      case "done":
        // 释放锁之后再复核：期间到达、因锁被占而直接结束的任务的事件由这里补上
        if (outcome.seen !== undefined) await this.followUp(conversationId, outcome.seen);
        return;
      case "stopped":
        return;
      case "changed":
        // 连接改过（轮换凭据等）：释放锁之后排新任务，用新的出站会话从 last_seq 接着投
        await this.enqueue(conversationId, { followUp: true });
        return;
      case "pending":
        return this.pluginPending(job, token, "delivery");
    }
  }

  /** 日志比本任务处理到的更新时再排一个任务。 */
  private async followUp(conversationId: string, seen: number): Promise<void> {
    const conv = await this.d.db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (conv && Number(conv.last_seq) > seen)
      await this.enqueue(conversationId, { followUp: true });
  }

  /** 不可重试（或重试用尽）的发送失败：记连接 `last_error`（已打码）。 */
  private async recordError(connectionId: string, message: string): Promise<void> {
    const text = `delivery failed: ${message}`.slice(0, MAX_ERROR_CHARS);
    this.d.log.warn("channel delivery failed", { connectionId, error: text });
    await this.d.db
      .updateTable("channel_connections")
      .set({ last_error: text })
      .where("id", "=", connectionId)
      .execute()
      .catch((err) => this.d.log.warn("cannot record channel delivery error", { err }));
  }
}

/**
 * 一次任务的结果：`done` 正常结束（`seen` 为处理到的 seq，供结束后复核；没有可投递的地方时不带）；
 * `stopped` 不可重试失败、本会话本轮停止（不复核，否则会立刻重试同一个事件）；`lost` 锁丢失；`shutdown` 停机；
 * `pending` 本副本没有加载连接的插件（推迟重试）；`changed` 连接在投递中被改过（排新任务接着投）。
 * 投递中连接被停用 / 删除按 `done`（不带 seen，不复核）结束。
 * `error` 需要记到连接 `last_error` 的失败说明。
 */
type DeliveryOutcome = (
  | { kind: "done"; seen?: number }
  | { kind: "stopped" }
  | { kind: "lost" }
  | { kind: "shutdown" }
  | { kind: "pending" }
  | { kind: "changed" }
) & { error?: { connectionId: string; message: string } };

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
  private session: ChannelOutboundSession | undefined;
  private target!: ChannelTarget;
  private locale: ChannelLocale = "en";
  private base: string | undefined;
  /** 已处理到的事件 seq（内存）与已写入 PG 的 seq。 */
  private seen = 0;
  private persisted = 0;
  /** 正在投递的事件（不可重试失败按它计数）。 */
  private handling: number | undefined;
  /** 当前草稿消息 id（PG 里的 `draft_message_id`）与它所属的步骤（从 PG 读出的草稿不知道步骤）。 */
  private draftId: string | null = null;
  private draftKey: string | undefined;
  /** 草稿当前显示的文本（从 PG 读出的草稿不知道）。 */
  private draftText: string | undefined;
  private lastDraftAt = 0;
  private streaming: StreamingText | undefined;
  private dirty = false;
  /** 任务开始时连接的 `updated_at`（毫秒）与上次复核连接的时刻。 */
  private version = 0;
  private checkedAt = 0;
  /** 平台不可重试地拒绝了对草稿的编辑：不再编辑它，定稿改发新消息（Ruling A22）。 */
  private draftBroken = false;
  /** 已定稿的步骤：之后到达的增量丢弃。 */
  private readonly finalized = new Set<string>();

  constructor(
    private readonly d: ChannelOutboundDeps,
    private readonly conversationId: string,
    private readonly lease: Lease,
    private readonly stopping: AbortSignal,
  ) {}

  private get s(): ChannelOutboundSession {
    return this.session as ChannelOutboundSession;
  }

  /** 普通消息的幂等键（Ruling A15）：`<会话>-<seq>[后缀]` 的稳定哈希。 */
  private key(seq: number, suffix = ""): string {
    return idempotencyKey(`${this.conversationId}-${seq}${suffix}`);
  }

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
        // 插件在本副本未加载（滚动升级期间新插件只在部分副本上）：推迟重试，留给有插件的副本
        if (err instanceof ApiError && err.code === "plugin.not_found") return { kind: "pending" };
        // 连接已删除 / 插件在该组织停用 / 配置不再合法：没有可投递的地方
        if (err instanceof ApiError) {
          this.d.log.warn("channel delivery skipped", {
            conversationId: this.conversationId,
            code: err.code,
          });
          return { kind: "done" };
        }
        throw err;
      }
      if (this.s.row.status !== "active") return { kind: "done" };
      const version = await this.connectionVersion();
      if (version === undefined) return { kind: "done" };
      this.version = version;
      this.target = row.target as ChannelTarget;
      this.seen = Number(row.last_seq);
      this.persisted = this.seen;
      this.draftId = row.draft_message_id;
      this.locale = (await readOrgSettings(this.d.db, this.s.row.orgId)).locale;
      this.base = webBase(this.d.config().http.publicUrl);
      return await this.loop();
    } catch (err) {
      if (err instanceof DeliveryLostError) return { kind: "lost" };
      if (isChannelSendError(err) && !err.retryable) {
        const message = this.redact(errMsg(err));
        // Ruling A22：机器人被移出群 / 会话不存在 → 停止本轮，不计毒事件（不是连接的问题，不记 last_error）
        if (err.reason === "target_gone") {
          this.d.log.warn("channel delivery target is gone", {
            conversationId: this.conversationId,
            error: message,
          });
          return { kind: "stopped" };
        }
        const error = { connectionId: row.connection_id, message };
        // 凭据失效：记 last_error、停止本轮，不计毒事件（换好凭据后之后的事件照常续投）
        if (err.reason === "auth") return { kind: "stopped", error };
        if (this.handling !== undefined && (await this.countFailure(this.handling))) {
          return { kind: "done", seen: this.seen, error };
        }
        return { kind: "stopped", error };
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

  /**
   * 记一次不可重试的失败（按事件 seq 计数，Ruling A14）。同一事件失败满 {@link POISON_FAILURES} 次：
   * 跳过它（推进 `last_seq` 越过它、清掉草稿），尽力发一句「请到网页上查看」，返回 true。
   */
  private async countFailure(seq: number): Promise<boolean> {
    const r = await this.d.db
      .updateTable("channel_deliveries")
      .set({
        fail_count: sql<number>`CASE WHEN fail_seq = ${seq} THEN fail_count + 1 ELSE 1 END`,
        fail_seq: seq,
      })
      .where("conversation_id", "=", this.conversationId)
      .where("last_seq", "=", String(this.persisted))
      .returning("fail_count")
      .executeTakeFirst();
    if (!r || r.fail_count < POISON_FAILURES) return false;
    this.d.log.warn("channel delivery skipped an event that keeps failing", {
      conversationId: this.conversationId,
      seq,
    });
    // 尽力收尾挂着的草稿（同运行失败），再提示去网页查看；两者失败都不影响跳过
    try {
      await this.markDraft(seq, "failed");
    } catch (err) {
      this.d.log.warn("cannot close channel draft before skipping", { err: errMsg(err) });
    }
    try {
      await this.send({ text: phrase("handleOnWeb", this.locale) }, this.key(seq, "-skipped"));
    } catch (err) {
      this.d.log.warn("cannot send channel skip notice", { err: errMsg(err) });
    }
    await this.advance(seq, { draft: null });
    this.seen = seq;
    return true;
  }

  /** 连接的 `updated_at`（毫秒）；连接已停用 / 删除时为 undefined。 */
  private async connectionVersion(): Promise<number | undefined> {
    const r = await this.d.db
      .selectFrom("channel_connections")
      .select(["status", "updated_at"])
      .where("id", "=", this.s.row.id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return r?.status === "active" ? r.updated_at.getTime() : undefined;
  }

  /**
   * 至多每 {@link IDLE_POLL_MS} 复核一次连接：停用 / 删除 → `done`（不复核、不再投递）；改过（轮换凭据等，
   * `updated_at` 变了）→ `changed`（释放锁后排新任务，用新的出站会话接着投）；没变返回 undefined。
   */
  private async recheckConnection(): Promise<DeliveryOutcome | undefined> {
    if (Date.now() - this.checkedAt < IDLE_POLL_MS) return undefined;
    this.checkedAt = Date.now();
    const v = await this.connectionVersion();
    if (v === undefined) return { kind: "done" };
    if (v !== this.version) return { kind: "changed" };
    return undefined;
  }

  private async loop(): Promise<DeliveryOutcome> {
    const idleMs = this.d.config().channels.deliveryIdleMs;
    let lastMessageAt = Date.now();
    let needCatchUp = true;
    this.checkedAt = Date.now();
    for (;;) {
      if (this.lease.lost) return { kind: "lost" };
      if (this.stopping.aborted) return { kind: "shutdown" };
      const changed = await this.recheckConnection();
      if (changed) return changed;
      if (needCatchUp) {
        await this.catchUp();
        needCatchUp = false;
      }
      while (this.inbox.length > 0) {
        if (this.lease.lost) return { kind: "lost" };
        const m = this.inbox.shift() as ConversationBusMessage;
        if (m.kind === "events") {
          if (m.toSeq > this.seen) await this.catchUp();
        } else {
          this.onDelta(m);
        }
      }
      await this.flushDraft();
      if (await this.waitWake(IDLE_POLL_MS)) {
        lastMessageAt = Date.now();
        continue;
      }
      needCatchUp = true;
      const quiet = Date.now() - lastMessageAt >= idleMs;
      if (quiet || (await this.idle())) {
        await this.catchUp();
        needCatchUp = false;
        if (this.inbox.length > 0) continue;
        // 运行进入 waiting / 终态且读完；或已追上、长时间没有新输出（之后的事件会排新任务）
        if (quiet || (await this.idle())) return { kind: "done", seen: this.seen };
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
        this.handling = e.seq;
        await this.handle(e);
        this.handling = undefined;
        this.seen = e.seq;
      }
      if (evs.length < PAGE) break;
    }
    if (this.seen > this.persisted) await this.advance(this.seen);
  }

  /**
   * 推进 `last_seq`（同一事务记下草稿 / 卡片消息 id，清零失败计数）。以「仍是我上次写入的值」为条件：
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
          fail_seq: null,
          fail_count: 0,
          ...(opts.draft !== undefined && { draft_message_id: opts.draft }),
          updated_at: new Date(),
        })
        .where("conversation_id", "=", this.conversationId)
        .where("last_seq", "=", String(this.persisted))
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) throw new DeliveryLostError();
      if (opts.card) {
        const messageId = opts.card.messageId;
        await t
          .insertInto("channel_card_messages")
          .values({
            conversation_id: this.conversationId,
            connection_id: this.s.row.id,
            card_kind: opts.card.kind,
            card_id: opts.card.id,
            message_id: messageId,
            target: JSON.stringify(this.target),
          })
          .onConflict((oc) =>
            oc
              .columns(["conversation_id", "connection_id", "card_kind", "card_id"])
              .doUpdateSet({ message_id: messageId, target: JSON.stringify(this.target) }),
          )
          .execute();
      }
    });
    this.persisted = seq;
    if (opts.draft !== undefined) {
      this.draftId = opts.draft;
      if (opts.draft === null) {
        this.draftKey = undefined;
        this.draftText = undefined;
      }
    }
  }

  private send(message: OutboundMessage, idempotencyKey: string): Promise<{ messageId: string }> {
    return this.s.send(this.target, message, idempotencyKey);
  }

  private async handle(e: ConversationEvent): Promise<void> {
    switch (e.type) {
      case "assistant_message":
        return this.finalize(e.runId, e.payload.step, e.payload.content, e.seq);
      case "approval_requested": {
        if (this.base === undefined) {
          await this.send({ text: phrase("handleOnWeb", this.locale) }, this.key(e.seq));
          return this.advance(e.seq);
        }
        const card = await approvalCard(
          this.d,
          e.payload.approvalId,
          this.base,
          this.locale,
          this.s.redact,
        );
        if (!card) return;
        const { messageId } = await this.send(cardMessage(card.title, card), this.key(e.seq));
        return this.advance(e.seq, { card: { kind: "approval", id: card.id, messageId } });
      }
      case "question_asked": {
        if (this.base === undefined) {
          await this.send({ text: phrase("handleOnWeb", this.locale) }, this.key(e.seq));
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
          this.key(e.seq),
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
          this.key(e.seq),
        );
        return this.advance(e.seq);
      }
      case "approval_decided": {
        const at = await this.cardMessageOf("approval", e.payload.approvalId);
        if (!at || this.base === undefined) return;
        const card = await approvalCard(
          this.d,
          e.payload.approvalId,
          this.base,
          this.locale,
          this.s.redact,
        );
        if (!card) return;
        await this.replaceCard(
          at,
          cardMessage(card.title, card),
          idempotencyKey(`${this.conversationId}-approval-${card.id}-${card.state}`),
        );
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
        await this.replaceCard(
          at,
          cardMessage(phrase("questionTitle", this.locale), card),
          idempotencyKey(`${this.conversationId}-question-${card.id}-${card.state}`),
        );
        return this.advance(e.seq);
      }
      case "run_failed":
        // 有草稿：收尾为「已有文本 + 失败说明」；没有草稿：单发一句
        if (await this.closeDraft(e.seq, "failed")) return;
        await this.send({ text: phrase("runFailed", this.locale) }, this.key(e.seq));
        return this.advance(e.seq);
      case "run_aborted":
        // 中止时还挂着的草稿：加「已停止」并清掉，避免下一次回复去编辑它
        await this.closeDraft(e.seq, "stopped");
        return;
      case "run_finished":
        // 正常结束却还挂着草稿（没有等到定稿）：草稿原样保留，只清掉 id
        await this.closeDraft(e.seq, "none");
        return;
      default:
        return;
    }
  }

  /** 按 {@link closingText} 改写挂着的草稿消息（`none` 不改）；不推进进度。没有草稿返回 false。 */
  private async markDraft(seq: number, how: DraftClosing): Promise<boolean> {
    if (this.draftId === null) return false;
    this.streaming = undefined;
    this.dirty = false;
    const text = closingText(this.draftText, how, this.locale);
    if (text !== undefined && this.s.features.edit) {
      if (this.draftBroken) {
        // 草稿已不能编辑：说明作为新消息发出，不静默丢掉
        const marker = phrase(how === "failed" ? "runFailed" : "runStopped", this.locale);
        await this.send({ text: marker }, this.key(seq, `-close-${how}`));
      } else {
        await this.s.update(this.target, this.draftId, { text }, this.key(seq, `-close-${how}`));
      }
    }
    return true;
  }

  /** 收尾挂着的草稿（见 {@link markDraft}）并清掉草稿 id。没有草稿返回 false。 */
  private async closeDraft(seq: number, how: DraftClosing): Promise<boolean> {
    if (!(await this.markDraft(seq, how))) return false;
    await this.advance(seq, { draft: null });
    return true;
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
      .where("connection_id", "=", this.s.row.id)
      .where("card_kind", "=", kind)
      .where("card_id", "=", id)
      .executeTakeFirst();
    return r && { messageId: r.message_id, target: r.target as ChannelTarget };
  }

  /**
   * 更新卡片状态。不能编辑已发消息的渠道（`features.edit` 为 false）另发一条带新状态的卡片——
   * 旧卡片上的按钮仍然在，之后再点由 `decide` / `answer` 回「已处理」，不会重复生效。
   */
  private async replaceCard(
    at: { messageId: string; target: ChannelTarget },
    message: OutboundMessage,
    idempotencyKey: string,
  ): Promise<void> {
    if (this.s.features.edit) {
      await this.s.update(at.target, at.messageId, message, idempotencyKey);
    } else {
      await this.s.send(at.target, message, idempotencyKey);
    }
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
      this.s.features.edit &&
      (this.draftKey === undefined || this.draftKey === key);
    if (text.trim() === "") {
      // 草稿已发出、定稿却没有文本（如重试后这一步只调用工具）：草稿原样保留、不加说明，只清掉 id
      if (useDraft) await this.closeDraft(seq, "none");
      return;
    }
    if (useDraft && !this.draftBroken) {
      try {
        await this.s.update(this.target, this.draftId as string, { text }, this.key(seq));
      } catch (err) {
        if (!editRejected(err)) throw err;
        // 编辑草稿被拒（消息太旧不能再改、内容被拒等）：把完整文本作为新消息发出，不计毒事件
        this.d.log.warn("channel draft edit rejected; sending the final text as a new message", {
          conversationId: this.conversationId,
          error: this.redact(errMsg(err)),
        });
        await this.send({ text }, this.key(seq));
      }
    } else {
      await this.send({ text }, this.key(seq));
    }
    await this.advance(seq, { draft: null });
  }

  /** 流式增量：只累积本步从头收到的文本（`offset` 对得上），增量本身不进日志、不推进进度。 */
  private onDelta(m: Extract<ConversationBusMessage, { kind: "delta" }>): void {
    if (!this.s.features.edit) return;
    const key = `${m.runId}:${m.step}`;
    if (this.finalized.has(key)) return;
    if (m.delta === "step_reset") {
      // 该步重试：此前的文本作废，下一次尝试从 offset 0 重新开始
      this.streaming = { key, text: "", complete: false };
      return;
    }
    if (m.delta !== "text" || m.text === undefined) return;
    const cur = this.streaming?.key === key ? this.streaming : undefined;
    if (m.offset === 0) {
      this.streaming = { key, text: m.text, complete: true };
    } else if (cur?.complete && m.offset === cur.text.length) {
      cur.text += m.text;
    } else {
      this.streaming = { key, text: cur?.text ?? "", complete: false };
      return;
    }
    this.dirty = true;
  }

  /**
   * 首次有文本时发草稿（先把消息 id 写进 PG 再继续），之后至多每 `max(1s, features.minEditIntervalMs)` 更新一次。
   */
  private async flushDraft(): Promise<void> {
    const cur = this.streaming;
    if (!cur?.complete || !this.dirty || cur.text.trim() === "") return;
    if (this.draftId !== null && this.draftKey !== undefined && this.draftKey !== cur.key) return;
    const now = Date.now();
    if (this.draftId === null) {
      const { messageId } = await this.send(
        { text: cur.text },
        idempotencyKey(`${this.conversationId}-draft-${cur.key}`),
      );
      const r = await this.d.db
        .updateTable("channel_deliveries")
        .set({ draft_message_id: messageId, updated_at: new Date() })
        .where("conversation_id", "=", this.conversationId)
        .where("last_seq", "=", String(this.persisted))
        .executeTakeFirst();
      if (r.numUpdatedRows === 0n) throw new DeliveryLostError();
      this.draftId = messageId;
      this.draftKey = cur.key;
    } else {
      if (this.draftBroken) return;
      const interval = Math.max(DRAFT_INTERVAL_MS, this.s.features.minEditIntervalMs ?? 0);
      if (now - this.lastDraftAt < interval) return;
      try {
        await this.s.update(this.target, this.draftId, { text: cur.text });
      } catch (err) {
        if (!editRejected(err)) throw err;
        // 中途编辑被拒：不再编辑草稿，定稿时改发新消息
        this.draftBroken = true;
        this.dirty = false;
        return;
      }
      this.draftKey = cur.key;
    }
    this.draftText = cur.text;
    this.lastDraftAt = now;
    this.dirty = false;
  }
}
