import { randomUUID } from "node:crypto";
import {
  type ChannelCard,
  type ChannelTarget,
  type FormAnswer,
  type InputForm,
  isChannelSendError,
  type Logger,
  type OutboundMessage,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { DelayedError, type Job, UnrecoverableError, type Worker } from "bullmq";
import { sql } from "kysely";
import { AutomationsService } from "../automations/automations.service.js";
import { productName } from "../config/product-name.js";
import {
  type ConversationBusMessage,
  conversationTopic,
  EventLog,
} from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import { recipientLocale } from "../conversations/message-context.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { type BlobRef, BlobsService } from "../files/blobs.service.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import {
  type ConversationLeases,
  ConversationLock,
  type Lease,
} from "../runtime/conversation-lock.js";
import type { StreamBus } from "../runtime/stream.js";
import { ApprovalsService } from "../tools/approvals.service.js";
import { type ToolInfo, toolInfo } from "../tools/info.js";
import { QuestionsService } from "../tools/questions.service.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  approvalCard,
  callSummary,
  cardMessage,
  connectUrl,
  conversationUrl,
  personFieldsCard,
  questionCard,
  webBase,
} from "./cards.js";
import {
  ChannelConnections,
  type ChannelOutboundSession,
  FILE_CALL_TIMEOUT_MS,
} from "./connections.service.js";
import { processDisplayOf, progressCardMessage } from "./features.js";
import {
  type FileDeliveryPlan,
  FileSlots,
  fileKind,
  fileLinkText,
  fileRootText,
  planFileDelivery,
  pluginFileName,
  readArtifactCapped,
  referencedBlob,
} from "./file-delivery.js";
import { ChannelInbound } from "./inbound.js";
import {
  type ChannelJobData,
  ChannelJobs,
  type DeliverJobData,
  INBOUND_JOB,
  type InboundJobData,
  idempotencyKey,
  RESUME_JOB,
  type ResumeJobData,
} from "./jobs.js";
import { type ChannelLocale, phrase } from "./phrases.js";
import {
  initProgress,
  type ProgressState,
  progressCard,
  promotedAnswer,
  reduceProgress,
  statusLine,
} from "./progress.js";
import { insertThread } from "./threads.js";

// The queue, job names, ids and priorities live with the producer (jobs.ts)
export {
  CHANNEL_QUEUE_NAME,
  DELIVER_ATTEMPTS,
  DELIVER_JOB,
  DELIVER_PRIORITY,
  deliverJobId,
  followUpJobId,
  INBOUND_ATTEMPTS,
  INBOUND_JOB,
  INBOUND_PRIORITY,
  idempotencyKey,
  inboundJobId,
} from "./jobs.js";

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
/**
 * A channel without edits gets a milestone message (the pinned card's text) at most this often per
 * run (process blocks spec §10.4); measured between the events' log times, so every replica decides
 * the same.
 */
export const MILESTONE_INTERVAL_MS = 60_000;
/** 没有新消息时多久复核一次（是否该结束、是否有待刷新的草稿）。 */
const IDLE_POLL_MS = 500;
/** 投递锁丢失 / 被自己上一次（已崩溃的）尝试占着时，任务推迟多久再试。 */
const LOCK_BUSY_DELAY_MS = 1000;
/** 本副本没有加载连接的插件时，任务推迟多久再试（滚动升级期间由有插件的副本接手）。 */
const PLUGIN_PENDING_DELAY_MS = 5000;
/** 插件一直没有在任何副本上加载：任务排进队列这么久之后放弃（之后的新事件会再排任务）。 */
const PLUGIN_PENDING_MAX_MS = 3_600_000;
/** 同一事件不可重试地失败这么多次后跳过它（Ruling A14）。 */
export const POISON_FAILURES = 3;
/** 退避：未给出建议等待时长时 `min(上限, 基数 · 2^(n-1))`。 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** 补读事件的分页大小。 */
const PAGE = 200;
/** `last_error` 的最大长度（同渠道选主）。 */
const MAX_ERROR_CHARS = 1000;

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

/** The replica stops while a delivery waits for a file slot: the job is handed back as it is. */
class DeliveryShutdownError extends Error {
  override name = "DeliveryShutdownError";
}

type ArtifactCreated = Extract<ConversationEvent, { type: "artifact_created" }>;
type ArtifactPayload = ArtifactCreated["payload"];

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

/**
 * The language of the kernel text a conversation's IM thread gets (cards, notices; maintainer
 * decision 2026-11-08: in IM, language is per person). The person who triggered the run speaks:
 * the `locale` recorded on the conversation's latest `user_message` at or before `uptoSeq`, which
 * already follows the order IM language, latest web message language, org language
 * (`readMessageContext`). In a group thread that is whoever wrote last, i.e. the requester of the
 * approvals and questions that follow. A message without one (a sub-agent's task): its author's
 * language by {@link recipientLocale}; no user message at all: the conversation owner's.
 * Read from PG, so any replica derives the same value.
 */
export async function conversationLocale(
  db: KernelSchemaDb,
  orgId: string,
  conversationId: string,
  uptoSeq: number,
): Promise<ChannelLocale> {
  const m = await db
    .selectFrom("conversation_events")
    .select([
      sql<string | null>`payload->>'locale'`.as("locale"),
      sql<string | null>`payload->>'authorAccountId'`.as("author"),
    ])
    .where("conversation_id", "=", conversationId)
    .where("type", "=", "user_message")
    .where("seq", "<=", String(uptoSeq))
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  if (m?.locale === "zh" || m?.locale === "en") return m.locale;
  let accountId = m?.author ?? null;
  if (accountId === null) {
    const c = await db
      .selectFrom("conversations")
      .select("account_id")
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    accountId = c?.account_id ?? null;
  }
  return recipientLocale(db, { orgId, accountId });
}

/** BullMQ 退避：平台给了等待时长就用它，否则指数退避。 */
export function deliverBackoff(attemptsMade: number, err?: Error): number {
  if (err instanceof RetryableDeliveryError && err.retryAfterMs !== undefined) {
    return Math.min(BACKOFF_MAX_MS, Math.max(0, err.retryAfterMs));
  }
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptsMade - 1));
}

/** What one delivery job ({@link Delivery}) reads and writes through. */
interface DeliveryDeps {
  /** The context-aware kernel-schema handle (read at call time). */
  readonly db: KernelSchemaDb;
  bus: StreamBus;
  eventLog: Pick<EventLog, "readAfter">;
  connections: Pick<ChannelConnections, "outbound">;
  approvals: Pick<ApprovalsService, "describe">;
  /** Tool titles and key arguments for an approval card without a summary. */
  registry: Pick<ToolRegistry, "builtinSpecs" | "extensionToolSpecs">;
  questions: Pick<QuestionsService, "forCall">;
  config: Pick<KernelConfigService, "get">;
  log: Pick<Logger, "error" | "warn" | "info">;
  /**
   * Conversation files are read from their blobs under the connection's org (spec §4.7; file
   * library spec §4), with the recorded size and etag checked.
   */
  blobs: Pick<BlobsService, "open">;
  /** At most `channels.fileConcurrency` file reads and uploads at once in this process (§4.2). */
  fileSlots: FileSlots;
  /**
   * The conditional `last_seq` advance ({@link ChannelOutbound.advanceIn}), the binding of a
   * scheduled group run's thread ({@link ChannelOutbound.bindThreadIn}) and the connection's
   * `last_error` ({@link ChannelOutbound.recordError}: a file the platform refused).
   */
  writes: Pick<ChannelOutbound, "advanceIn" | "bindThreadIn" | "recordError">;
}

/** One `last_seq` advance of a delivery (see {@link ChannelOutbound.advanceIn}). */
export interface DeliveryAdvance {
  conversationId: string;
  /** The `last_seq` this delivery wrote last: the update applies only while it is still there. */
  persisted: number;
  seq: number;
  draft?: string | null;
  /**
   * A run's progress message was posted (null: a channel without edits, which posts none): its id
   * and run are recorded, the milestone time and the re-post flag cleared (process blocks spec
   * §6.3).
   */
  progress?: { messageId: string | null; runId: string };
  /** A milestone message was sent: the log time of its event. */
  milestoneAt?: Date;
  /** The ended run's card got its final edit (or was refused it for good). */
  progressFinal?: true;
  card?: {
    kind: "approval" | "question";
    id: string;
    messageId: string;
    connectionId: string;
    target: ChannelTarget;
  };
}

/**
 * 渠道出站投递：把会话日志里 `channel_deliveries.last_seq` 之后的内容按序投到 IM。
 * - 生产方（任意角色）：{@link ChannelJobs}（`deliver-<会话>-<当前 seq>` 任务；会话没有投递目标时什么都不做）。
 * - Worker（只在 worker 角色，经 `@Processor`）：每个任务先取按会话互斥的投递锁，订阅 `conv.<id>` 后补读日志；运行进入 waiting /
 *   终态且日志读完，或追上后 `channels.deliveryIdleMs` 内没有新的总线消息，任务就结束（不长期占并发槽）。
 *   锁被别的任务持有 → 本任务直接结束：持有者会读到新事件，且它结束时（释放锁之后）复核日志是否有新内容，有就再排一个任务；
 *   锁被自己上一次（已崩溃的）尝试占着 → 推迟重试，等锁过期。
 *   崩溃后 BullMQ stalled 机制把任务交给其他副本，从 `last_seq` 续投；每投递一个事件就在同一事务里推进 `last_seq`
 *   并记下 IM 消息 id（草稿 id、卡片消息 id），已投递的不会重发。
 *   审批 / 提问卡片在发送之前先记一行 `pending`（T5a），卡片一出现就被点击也能通过 Ruling A13 的核对；
 *   推进 `last_seq` 的事务再补上消息 id、改为 `sent`。崩溃后续投的副本用同一个幂等键重发。
 * 同一队列还承载入站任务（`inbound`，Ruling A21）：由 {@link ChannelJobs.enqueueInbound} 排入，worker 调用
 * {@link ChannelInbound.handle} 处理，失败按 BullMQ 指数退避重试。
 * 状态全部在 PG / Redis；进程内只有本任务自己的订阅、草稿节流时刻与等待定时器（本进程持有的资源）。
 */
@Injectable()
export class ChannelOutbound {
  private worker: Worker<ChannelJobData> | undefined;
  private closed = false;
  /** 停机：进行中的任务在下一个检查点交还队列（由其他副本续投）。 */
  private readonly stopping = new AbortController();
  private readonly lock: ConversationLeases;
  private readonly d: DeliveryDeps;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(KERNEL_BUS) bus: StreamBus,
    @Inject(EventLog) eventLog: Pick<EventLog, "readAfter">,
    /** The conversation lock provider; delivery takes it under its own key prefix. */
    @Inject(ConversationLock) lock: Pick<ConversationLock, "scoped">,
    @Inject(ChannelConnections) connections: Pick<ChannelConnections, "outbound">,
    @Inject(ApprovalsService) approvals: Pick<ApprovalsService, "describe">,
    @Inject(QuestionsService) questions: Pick<QuestionsService, "forCall">,
    @Inject(ToolRegistry) registry: Pick<ToolRegistry, "builtinSpecs" | "extensionToolSpecs">,
    /** 入站任务的处理（worker 上执行 `ChannelInbound.handle`）；失败抛错由 BullMQ 重试。 */
    @Inject(ChannelInbound) private readonly inbound: Pick<ChannelInbound, "handle">,
    @Inject(ChannelJobs) private readonly jobs: Pick<ChannelJobs, "enqueue" | "resumeConnection">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "error" | "warn" | "info">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** Pauses the task of a scheduled run whose chat is gone (scheduled tasks spec §8). */
    @Inject(AutomationsService)
    private readonly automations: Pick<AutomationsService, "pauseFor">,
    /** The blobs of conversation files sent into the chat (channel file delivery spec §4.2). */
    @Inject(BlobsService) blobs: Pick<BlobsService, "open">,
  ) {
    this.lock = lock.scoped(DELIVER_LOCK_PREFIX);
    this.d = {
      get db() {
        return kdb.db;
      },
      bus,
      eventLog,
      connections,
      approvals,
      registry,
      questions,
      config,
      log,
      blobs,
      // one per process: it bounds this replica's memory (not shared state)
      fileSlots: new FileSlots(config.get().channels.fileConcurrency),
      writes: this,
    };
  }

  /**
   * Starts consuming (worker role only): `worker` is the `@Processor` worker of the channel queue
   * (its job lock and stalled detection follow the run queue's config).
   */
  startWorker(worker: Worker<ChannelJobData>): void {
    if (this.worker || this.closed) return;
    this.worker = worker;
    void worker.run().catch((err) => this.onError(err));
  }

  /** The worker's `error` event. */
  onError(err: Error): void {
    this.log.error("channel outbound worker error", { err });
  }

  /** The worker's `failed` event (a requeue for later is not a failure). */
  onFailed(job: Job<ChannelJobData> | undefined, err: Error): void {
    if (err instanceof DelayedError || err.name === "DelayedError") return;
    this.log.warn("channel delivery attempt failed", { jobId: job?.id, error: err.message });
  }

  /** Stops: the jobs in flight are handed back at their next checkpoint, the worker closes. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopping.abort();
    const w = this.worker;
    this.worker = undefined;
    await w?.close().catch(() => {});
  }

  private async requeue(job: Job, token: string | undefined, delayMs: number): Promise<never> {
    await job.moveToDelayed(Date.now() + delayMs, token);
    throw new DelayedError();
  }

  /**
   * One job of the channel queue (the `@Processor` calls it): a delivery, an inbound event or a
   * connection's catch-up.
   */
  async process(job: Job<ChannelJobData>, token: string | undefined): Promise<void> {
    if (this.stopping.signal.aborted) return this.requeue(job, token, 0);
    if (job.name === INBOUND_JOB) return this.processInbound(job as Job<InboundJobData>, token);
    // a connection's catch-up: a failed add fails the job, which BullMQ retries
    if (job.name === RESUME_JOB) {
      return this.jobs.resumeConnection((job.data as ResumeJobData).connectionId);
    }
    return this.deliver(job as Job<DeliverJobData>, token);
  }

  /** 本副本没有加载连接的插件：推迟重试（不消耗重试次数），排队超过上限才放弃。 */
  private async pluginPending(job: Job, token: string | undefined, what: string): Promise<void> {
    if (Date.now() - job.timestamp > PLUGIN_PENDING_MAX_MS) {
      this.log.warn(`channel ${what} dropped: extension not loaded on any replica in time`, {
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
    try {
      await this.inbound.handle(connectionId, event);
    } catch (err) {
      if (err instanceof ApiError && err.code === "extension.not_found") {
        return this.pluginPending(job, token, "inbound event");
      }
      if (
        isChannelSendError(err) &&
        !err.retryable &&
        (err.reason === "auth" || err.reason === "target_gone")
      ) {
        this.log.warn("channel inbound reply failed permanently", {
          connectionId,
          type: event.type,
          reason: err.reason,
        });
        throw new UnrecoverableError(`inbound reply failed: ${err.reason}`);
      }
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        this.log.error("channel inbound event dropped after retries", {
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
        this.config.get().runtime.jobLockMs,
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
    // 本次尝试开始时的日志位置：持锁期间提交的事件，其任务见锁被占直接结束，靠本任务结束时复核补上
    const startSeq = await this.lastSeq(conversationId);
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
          this.log.warn("cannot release channel delivery lock", { conversationId, err }),
        );
    }
    if (outcome.error) await this.recordError(outcome.error.connectionId, outcome.error.message);
    if (outcome.gone) {
      await this.pauseAutomationIn(conversationId, outcome.gone.runId).catch((err) =>
        this.log.warn("cannot pause the automation of a gone chat", { conversationId, err }),
      );
    }
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
        // 不可重试失败：只在本次尝试开始之后又有新事件时复核（那些事件的任务因锁被占已直接结束，
        // 否则「后续事件触发续投」会丢）；没有新事件就停下，不立刻重试同一个事件
        if (startSeq !== undefined) await this.followUp(conversationId, startSeq);
        return;
      case "changed":
        // 连接改过（轮换凭据等）：释放锁之后排新任务，用新的出站会话从 last_seq 接着投
        await this.jobs.enqueue(conversationId, { followUp: true });
        return;
      case "pending":
        return this.pluginPending(job, token, "delivery");
    }
  }

  /** 会话日志当前的最后位置（会话不存在时 undefined）。 */
  // org-filter: conversationId comes from the kernel-written delivery job payload, not caller input
  private async lastSeq(conversationId: string): Promise<number | undefined> {
    const conv = await this.kdb
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    return conv ? Number(conv.last_seq) : undefined;
  }

  /** 日志比 `seen` 更新时再排一个任务。 */
  private async followUp(conversationId: string, seen: number): Promise<void> {
    const last = await this.lastSeq(conversationId);
    if (last !== undefined && last > seen)
      await this.jobs.enqueue(conversationId, { followUp: true });
  }

  /** A non-retryable (or finally failed) send: the connection's `last_error` (already redacted). */
  async recordError(connectionId: string, message: string): Promise<void> {
    const text = `delivery failed: ${message}`.slice(0, MAX_ERROR_CHARS);
    this.log.warn("channel delivery failed", { connectionId, error: text });
    // org-filter: connectionId is the delivery's own connection (kernel-written job / row)
    await this.kdb
      .updateTable("channel_connections")
      .set({ last_error: text })
      .where("id", "=", connectionId)
      .execute()
      .catch((err) => this.log.warn("cannot record channel delivery error", { err }));
  }

  /**
   * 推进 `last_seq`（同一事务记下草稿 / 卡片消息 id，清零失败计数）。以「仍是 `persisted`」为条件：
   * 被别人推进过（投递锁丢失后另一实例接手）返回 false，什么都不写。
   */
  @Transactional()
  async advanceIn(a: DeliveryAdvance): Promise<boolean> {
    const r = await this.kdb
      .updateTable("channel_deliveries")
      .set({
        last_seq: String(a.seq),
        fail_seq: null,
        fail_count: 0,
        ...(a.draft !== undefined && { draft_message_id: a.draft }),
        ...(a.progress !== undefined && {
          progress_message_id: a.progress.messageId,
          progress_run_id: a.progress.runId,
          milestone_at: null,
          progress_reposted: false,
          progress_final: false,
        }),
        ...(a.milestoneAt !== undefined && { milestone_at: a.milestoneAt }),
        ...(a.progressFinal && { progress_final: true }),
        updated_at: new Date(),
      })
      .where("conversation_id", "=", a.conversationId)
      .where("last_seq", "=", String(a.persisted))
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) return false;
    if (a.card) {
      // The row was recorded as `pending` before the send (recordCard); fill in the message id
      const { messageId, target } = a.card;
      await this.kdb
        .insertInto("channel_card_messages")
        .values({
          conversation_id: a.conversationId,
          connection_id: a.card.connectionId,
          card_kind: a.card.kind,
          card_id: a.card.id,
          message_id: messageId,
          status: "sent",
          target: JSON.stringify(target),
        })
        .onConflict((oc) =>
          oc.columns(["conversation_id", "connection_id", "card_kind", "card_id"]).doUpdateSet({
            message_id: messageId,
            status: "sent",
            target: JSON.stringify(target),
          }),
        )
        .execute();
    }
    return true;
  }

  /**
   * Binds a scheduled group run's thread at its first post (scheduled tasks spec §8): the delivery
   * target gets `threadId` = the posted message's id, and a thread row (key = that id, account =
   * `pending_thread_account_id`) points at the conversation, so replies in that thread continue it,
   * as an inbound top-level message's thread would. Conditional on the binding still pending; when
   * it is not (another attempt bound it), returns the stored target.
   */
  @Transactional()
  async bindThreadIn(conversationId: string, messageId: string): Promise<ChannelTarget> {
    const row = await this.kdb
      .selectFrom("channel_deliveries")
      .select(["connection_id", "target", "pending_thread_account_id"])
      .where("conversation_id", "=", conversationId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new DeliveryLostError();
    const stored = row.target as ChannelTarget;
    if (row.pending_thread_account_id === null) return stored;
    const target: ChannelTarget = { ...stored, threadId: messageId };
    await this.kdb
      .updateTable("channel_deliveries")
      .set({
        target: JSON.stringify(target),
        pending_thread_account_id: null,
        updated_at: new Date(),
      })
      .where("conversation_id", "=", conversationId)
      .execute();
    await insertThread(
      this.kdb.db,
      {
        connectionId: row.connection_id,
        chatId: stored.chatId,
        threadKey: messageId,
        accountId: row.pending_thread_account_id,
      },
      conversationId,
    );
    return target;
  }

  /**
   * A delivery failed for good because the chat is gone or the connection's credentials are
   * (`ChannelSendError` `target_gone` / `auth`): when the run being delivered serves a scheduled
   * task run (`runs.automation_run_id`), its task pauses with `target_gone` (spec §8), so later
   * ticks do not keep running into the same chat. `runId` is the run of the event being delivered;
   * without one (a streaming draft), the conversation's latest run. A person's run pauses nothing.
   */
  @Transactional()
  async pauseAutomationIn(conversationId: string, runId: string | null): Promise<void> {
    let q = this.kdb
      .selectFrom("runs as r")
      .innerJoin("automation_runs as tr", "tr.id", "r.automation_run_id")
      .select(["tr.automation_id", "r.automation_run_id"])
      .where("r.conversation_id", "=", conversationId);
    q = runId !== null ? q.where("r.id", "=", runId) : q.orderBy("r.created_at", "desc").limit(1);
    const row = await q.executeTakeFirst();
    if (!row) return;
    await this.automations.pauseFor(this.kdb.db, row.automation_id, "target_gone", null);
    this.log.info("automation paused: its chat is gone", {
      conversationId,
      taskId: row.automation_id,
      taskRunId: row.automation_run_id,
    });
  }
}

/**
 * 一次任务的结果：`done` 正常结束（`seen` 为处理到的 seq，供结束后复核；没有可投递的地方时不带）；
 * `stopped` 不可重试失败、本会话本轮停止（只在本次尝试开始之后又有新事件时复核，不立刻重试同一个事件）；`lost` 锁丢失；`shutdown` 停机；
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
) & {
  error?: { connectionId: string; message: string };
  /** The chat is gone (`target_gone` / `auth`): the run whose event failed (automations §8). */
  gone?: { runId: string | null };
};

/** 一个步骤正在流式输出的文本（只在从头收到时才发草稿）。 */
interface StreamingText {
  key: string;
  text: string;
  /** Received in full from the first character of this attempt of the step. */
  complete: boolean;
}

/**
 * How a delivery shows a run's process (process blocks spec §6.2): `card` = one progress message
 * per run, edited in place (an edit channel, `detailed` / `brief`); `plain` = a start message and
 * milestone messages (a channel without edits); `off` = today's streaming draft and messages.
 */
type ProgressKind = "card" | "plain" | "off";

/** One `bind` card per handoff link, in one message (process blocks spec §6.2). */
function handoffsMessage(links: ProgressState["pending"], locale: ChannelLocale): OutboundMessage {
  const cards: ChannelCard[] = links.map((p) => {
    const text = p.titles?.[locale] ?? p.text;
    return { kind: "bind", text, url: p.url };
  });
  return { text: phrase("handoffs", locale).replace("{n}", String(cards.length)), cards };
}

const hasToolCall = (content: readonly { type: string }[]): boolean =>
  content.some((b) => b.type === "tool_call");

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
  /** The run of the event being delivered (a gone chat pauses its automation). */
  private handlingRun: string | null = null;
  /**
   * A scheduled group run's thread is still to bind (`pending_thread_account_id` set): the first
   * successful send binds it ({@link ChannelOutbound.bindThreadIn}).
   */
  private threadPending = false;
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
  /**
   * The platform rejected an edit of the draft for good: it is not edited again, and the final
   * text goes out as a new message (Ruling A22).
   */
  private draftBroken = false;
  /** Finished steps: deltas arriving later are dropped. */
  private readonly finalized = new Set<string>();
  /** How runs show their process here (read at the start of the job). */
  private progressKind: ProgressKind = "off";
  private display: "detailed" | "brief" = "detailed";
  /**
   * The current run's progress state: a fold of its events (rebuilt from the log at the start of a
   * job, never kept between jobs in memory); its message id and run are in PG.
   */
  private progress: ProgressState | undefined;
  private progressId: string | null = null;
  /** The log time of the run's last milestone message (`milestone_at`), ms. */
  private milestoneAt: number | null = null;
  /** The pinned text the run's last milestone message carried (rebuilt from the log). */
  private milestoneText: string | undefined;
  /** How many of `progress.pending` went out in a merged handoff message already. */
  private handoffsSent = 0;
  /** The card changed since its last edit, and when that edit was. */
  private progressDirty = false;
  private lastProgressAt = 0;
  /** The last edit failed retryably (cleared by a successful one). */
  private progressRetry: Error | undefined;
  /** The seq of the run's end event (its final edit's idempotency key); undefined while running. */
  private progressEndSeq: number | undefined;
  /** The ended card's final edit landed; the next advance records it (`progress_final`). */
  private progressFinalPending = false;
  /**
   * The run's card was re-posted after a rejected edit (once per run: in this job, or in an earlier
   * one, `progress_reposted`); a rejection after that stops the edits.
   */
  private progressReposted = false;
  private progressBroken = false;
  /** Tool display metadata for the card's step labels, per tool key (this job only). */
  private readonly toolInfos = new Map<string, ToolInfo | undefined>();

  constructor(
    private readonly d: DeliveryDeps,
    private readonly conversationId: string,
    private readonly lease: Lease,
    private readonly stopping: AbortSignal,
  ) {}

  private get s(): ChannelOutboundSession {
    return this.session as ChannelOutboundSession;
  }

  /** 普通消息的幂等键（Ruling A15）：`<会话>-<seq>[后缀]` 的稳定哈希。 */
  /** The platform name the web hints name (`platform.name`, read at each use: the field is hot). */
  private product(): string {
    return productName(this.d.config.get());
  }

  private key(seq: number, suffix = ""): string {
    return idempotencyKey(`${this.conversationId}-${seq}${suffix}`);
  }

  async run(): Promise<DeliveryOutcome> {
    const row = await this.d.db
      .selectFrom("channel_deliveries")
      .select([
        "connection_id",
        "target",
        "last_seq",
        "draft_message_id",
        "pending_thread_account_id",
        "progress_message_id",
        "progress_run_id",
        "milestone_at",
        "progress_reposted",
        "progress_final",
      ])
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
        if (err instanceof ApiError && err.code === "extension.not_found")
          return { kind: "pending" };
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
      const conn = await this.connectionState();
      if (conn === undefined) return { kind: "done" };
      this.version = conn.version;
      this.target = row.target as ChannelTarget;
      this.threadPending = row.pending_thread_account_id !== null;
      this.seen = Number(row.last_seq);
      this.persisted = this.seen;
      this.draftId = row.draft_message_id;
      this.locale = await conversationLocale(
        this.d.db,
        this.s.row.orgId,
        this.conversationId,
        this.seen,
      );
      this.base = webBase(this.d.config.get().http.publicUrl);
      const display = processDisplayOf(conn.processDisplay, this.target.chatType);
      // without a web base the card has no link to the full process: today's messages
      this.progressKind =
        display === "off" || this.base === undefined
          ? "off"
          : this.s.features.edit
            ? "card"
            : "plain";
      if (display !== "off") this.display = display;
      if (this.progressKind !== "off" && row.progress_run_id !== null) {
        this.progressId = row.progress_message_id;
        this.milestoneAt = row.milestone_at?.getTime() ?? null;
        this.progressReposted = row.progress_reposted;
        await this.rebuildProgress(row.progress_run_id, row.progress_final);
      }
      return await this.loop();
    } catch (err) {
      if (err instanceof DeliveryLostError) return { kind: "lost" };
      if (err instanceof DeliveryShutdownError) return { kind: "shutdown" };
      if (isChannelSendError(err) && !err.retryable) {
        const message = this.redact(errMsg(err));
        // Ruling A22：机器人被移出群 / 会话不存在 → 停止本轮，不计毒事件（不是连接的问题，不记 last_error）
        // either also pauses the automation of the run being delivered (automations §8)
        const gone = { runId: this.handlingRun };
        if (err.reason === "target_gone") {
          this.d.log.warn("channel delivery target is gone", {
            conversationId: this.conversationId,
            error: message,
          });
          return { kind: "stopped", gone };
        }
        const error = { connectionId: row.connection_id, message };
        // 凭据失效：记 last_error、停止本轮，不计毒事件（换好凭据后之后的事件照常续投）
        if (err.reason === "auth") return { kind: "stopped", error, gone };
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
      await this.send(
        { text: phrase("handleOnWeb", this.locale, this.product()) },
        this.key(seq, "-skipped"),
      );
    } catch (err) {
      this.d.log.warn("cannot send channel skip notice", { err: errMsg(err) });
    }
    // A card row recorded for the skipped event deliberately stays `pending`: the send may have
    // reached the platform even though it failed for us, so a click on it must still be accepted.
    // That is safe: Ruling A13 (same connection and chat), the plugin's signature checks and the
    // approver / asker authorization in decide / answer still apply.
    await this.advance(seq, { draft: null });
    this.seen = seq;
    return true;
  }

  /**
   * The connection's `updated_at` (ms) and process display setting, read live; undefined when it
   * is disabled or deleted. A changed setting bumps `updated_at`, so the job hands over (`changed`).
   */
  private async connectionState(): Promise<
    { version: number; processDisplay: string | null } | undefined
  > {
    const r = await this.d.db
      .selectFrom("channel_connections")
      .select(["status", "updated_at", "process_display"])
      .where("id", "=", this.s.row.id)
      .where("org_id", "=", this.s.row.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return r?.status === "active"
      ? { version: r.updated_at.getTime(), processDisplay: r.process_display }
      : undefined;
  }

  /**
   * 至多每 {@link IDLE_POLL_MS} 复核一次连接：停用 / 删除 → `done`（不复核、不再投递）；改过（轮换凭据等，
   * `updated_at` 变了）→ `changed`（释放锁后排新任务，用新的出站会话接着投）；没变返回 undefined。
   */
  private async recheckConnection(): Promise<DeliveryOutcome | undefined> {
    if (Date.now() - this.checkedAt < IDLE_POLL_MS) return undefined;
    this.checkedAt = Date.now();
    const v = (await this.connectionState())?.version;
    if (v === undefined) return { kind: "done" };
    if (v !== this.version) return { kind: "changed" };
    return undefined;
  }

  private async loop(): Promise<DeliveryOutcome> {
    const idleMs = this.d.config.get().channels.deliveryIdleMs;
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
        } else if (m.kind === "delta") {
          this.onDelta(m);
        }
      }
      await this.flushDraft();
      await this.flushProgress(false);
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
        // the run waits or ended and the log is read; or caught up with no output for long (later
        // events owe a new job)
        if (quiet || (await this.idle())) {
          // the card's last throttled change is not left for a job that may never come; an edit
          // still failing retryably fails this attempt, and the retry's rebuild edits the card
          await this.flushProgress(true);
          if (this.progressDirty && this.progressRetry !== undefined) throw this.progressRetry;
          return { kind: "done", seen: this.seen };
        }
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
      .where("org_id", "=", this.s.row.orgId)
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
        this.handlingRun = e.runId;
        await this.handle(e);
        this.handling = undefined;
        this.handlingRun = null;
        this.seen = e.seq;
      }
      if (evs.length < PAGE) break;
    }
    if (this.seen > this.persisted) await this.advance(this.seen);
  }

  /**
   * Advances `last_seq` (recording draft / card / progress ids in the same transaction, clearing
   * the failure count), on condition that it still holds the value this delivery wrote last:
   * advanced by someone else (another instance took over after the lock was lost) stops it, so
   * nothing is sent twice.
   */
  private async advance(
    seq: number,
    opts: {
      draft?: string | null;
      progress?: { messageId: string | null; runId: string };
      milestoneAt?: Date;
      progressFinal?: true;
      card?: { kind: "approval" | "question"; id: string; messageId: string };
    } = {},
  ): Promise<void> {
    const progressFinal = opts.progressFinal ?? (this.progressFinalPending ? true : undefined);
    const advanced = await this.d.writes.advanceIn({
      conversationId: this.conversationId,
      persisted: this.persisted,
      seq,
      ...(opts.draft !== undefined && { draft: opts.draft }),
      ...(opts.progress !== undefined && { progress: opts.progress }),
      ...(opts.milestoneAt !== undefined && { milestoneAt: opts.milestoneAt }),
      ...(progressFinal && { progressFinal }),
      ...(opts.card && {
        card: { ...opts.card, connectionId: this.s.row.id, target: this.target },
      }),
    });
    if (!advanced) throw new DeliveryLostError();
    this.persisted = seq;
    if (progressFinal) this.progressFinalPending = false;
    if (opts.draft !== undefined) {
      this.draftId = opts.draft;
      if (opts.draft === null) {
        this.draftKey = undefined;
        this.draftText = undefined;
      }
    }
  }

  /**
   * Record a card as `pending` before it is sent (T5a), in its own statement, so a click that arrives
   * as soon as the card shows up on the platform finds it (Ruling A13: the card must be one this
   * connection sent in this chat). The send's message id is filled in by {@link advance}. A row left
   * `pending` by a failed send or a dead replica is kept: the event is handled again from `last_seq`
   * and the card resent with the same idempotency key. An existing `sent` row is never touched.
   */
  private async recordCard(kind: "approval" | "question", id: string): Promise<void> {
    // Best-effort guard only (the lease can be lost right after it): correctness rests on
    // ON CONFLICT DO NOTHING below and on advance() being conditional on last_seq
    if (this.lease.lost) throw new DeliveryLostError();
    await this.d.db
      .insertInto("channel_card_messages")
      .values({
        conversation_id: this.conversationId,
        connection_id: this.s.row.id,
        card_kind: kind,
        card_id: id,
        message_id: null,
        status: "pending",
        target: JSON.stringify(this.target),
      })
      .onConflict((oc) =>
        oc.columns(["conversation_id", "connection_id", "card_kind", "card_id"]).doNothing(),
      )
      .execute();
  }

  /**
   * Sends into the delivery target. A scheduled group run's first post is its thread's root: once
   * the platform has it, the thread is bound to its id and later posts go into that thread. The
   * bind comes before the lease check: the root is posted, so it is recorded even when the lease
   * was lost meanwhile (the bind is conditional on still pending, so a holder that bound first
   * keeps its thread), and a retry never posts a second root.
   */
  private async send(
    message: OutboundMessage,
    idempotencyKey: string,
  ): Promise<{ messageId: string }> {
    const sent = await this.s.send(this.target, message, idempotencyKey, this.locale);
    if (this.threadPending) {
      this.target = await this.d.writes.bindThreadIn(this.conversationId, sent.messageId);
      this.threadPending = false;
      if (this.lease.lost) throw new DeliveryLostError();
    }
    return sent;
  }

  private async handle(e: ConversationEvent): Promise<void> {
    if (this.progressKind !== "off" && (await this.handleProgress(e))) return;
    switch (e.type) {
      case "user_message": {
        // a new message: what follows speaks its author's language (see conversationLocale)
        const l = e.payload.locale;
        if (l === "zh" || l === "en") this.locale = l;
        return;
      }
      case "assistant_message":
        return this.finalize(e.runId, e.payload.step, e.payload.content, e.seq);
      case "approval_requested":
        return this.approvalCardAt(e.seq, e.payload.approvalId);
      case "question_asked":
        return this.questionCardAt(e.seq, e.payload.questionId, e.payload.form as InputForm);
      case "subagent_waiting": {
        // a sub-agent's approval or question (sub-agents spec §9): the same card as the parent's
        // own, by id, so a conversation started from IM gets its sub-agents' requests in the thread.
        // A connect card stays on the web (the child got the connect text as its result).
        const p = e.payload;
        // the child's earlier requests may be decided by now: bring their cards up to date first
        // (the decisions are in the child's log, see subagent_finished below)
        if (p.kind !== "connect") await this.refreshChildCards(p.childRunId);
        if (p.kind === "approval" && p.approvalId !== undefined) {
          return this.approvalCardAt(e.seq, p.approvalId);
        }
        if (p.kind === "input" && p.questionId !== undefined) {
          const q = await this.d.db
            .selectFrom("questions")
            .select("spec")
            .where("id", "=", p.questionId)
            .where("org_id", "=", this.s.row.orgId)
            .executeTakeFirst();
          const form = (q?.spec as { form?: InputForm } | undefined)?.form;
          if (!form) return;
          return this.questionCardAt(e.seq, p.questionId, form, p.subagentId);
        }
        return;
      }
      case "subagent_finished":
        // the child's decisions were logged in the child's log, which this delivery does not read:
        // its cards in this thread are brought up to date once it is done
        if (await this.refreshChildCards(e.payload.childRunId)) return this.advance(e.seq);
        return;
      case "connection_required": {
        const text = phrase("connectTitle", this.locale);
        await this.send(
          this.base === undefined
            ? { text: phrase("handleOnWeb", this.locale, this.product()) }
            : cardMessage(text, {
                kind: "connect",
                appName: e.payload.appName,
                url: connectUrl(this.base, e.payload.appId),
              }),
          this.key(e.seq),
        );
        return this.advance(e.seq);
      }
      case "tool_result": {
        // a Platform operation's link card (platform web parity spec §6): a link to the web page
        // where the person decides; an OAuth connect opens the conversation, whose card starts it
        const v = e.payload.view;
        if (v?.kind !== "handoff") return;
        await this.send(
          this.base === undefined
            ? { text: phrase("handleOnWeb", this.locale, this.product()) }
            : cardMessage(v.title[this.locale], {
                kind: "bind",
                text: v.title[this.locale],
                url:
                  v.target.type === "link"
                    ? `${this.base}${v.target.url}`
                    : conversationUrl(this.base, this.conversationId),
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
      case "artifact_created":
        return this.deliverArtifact(e);
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

  /** Sends the approval card of `approvalId` for the event at `seq` (or the web hint). */
  private async approvalCardAt(seq: number, approvalId: string): Promise<void> {
    if (this.base === undefined) {
      await this.send({ text: phrase("handleOnWeb", this.locale, this.product()) }, this.key(seq));
      return this.advance(seq);
    }
    // secrets are typed on the web only (a secure input request, or a tool ask with person
    // fields): IM gets a link, never an approval card (no card is recorded, so `approval_decided`
    // has nothing to update)
    const bind = await personFieldsCard(this.d, approvalId, this.base, this.locale);
    if (bind) {
      await this.send(cardMessage(bind.text, bind), this.key(seq));
      return this.advance(seq);
    }
    const card = await approvalCard(this.d, approvalId, this.base, this.locale, this.s.redact);
    if (!card) return;
    await this.recordCard("approval", card.id);
    const { messageId } = await this.send(cardMessage(card.title, card), this.key(seq));
    return this.advance(seq, { card: { kind: "approval", id: card.id, messageId } });
  }

  /**
   * A conversation file (channel file delivery spec §4.2-§4.5): sent into the target as a native
   * file or image when the channel can take it, else as one link line. The object is read under the
   * connection's org within the cap (the stored size is authoritative); a missing object, an
   * unavailable store and a platform `too_large` / `rejected` (or a non-retryable failure without
   * a reason) become the link line, so the event is delivered and never counts towards poisoning;
   * `rejected` and no reason also record `last_error`. `auth`, `target_gone` and retryable failures
   * go to `run()` as for text. A scheduled group run whose first post is this file gets a text root
   * first (`sendFile` need not return a message id to bind the thread to).
   */
  private async deliverArtifact(e: ArtifactCreated): Promise<void> {
    const a = e.payload;
    // the file the event created (its id is the artifact id; earlier events name no fileId)
    const blob = await referencedBlob(
      this.d.db,
      this.s.row.orgId,
      this.conversationId,
      a.fileId ?? a.artifactId,
    );
    const plan = planFileDelivery({
      referenced: blob !== null,
      artifact: a,
      features: this.s.features,
      canSendFile: this.s.sendFile !== undefined,
      fileMaxBytes: this.d.config.get().channels.fileMaxBytes,
    });
    if (plan.mode === "link" || blob === null) {
      if (blob === null) {
        this.d.log.warn("channel file not referenced by the conversation sent as a link", {
          conversationId: this.conversationId,
          seq: e.seq,
        });
      }
      return this.linkLine(e.seq, a);
    }
    let release: () => void;
    try {
      release = await this.d.fileSlots.acquire(this.stopping);
    } catch (err) {
      // stopping while waiting for a slot: hand the job back (another replica resumes it)
      if (this.stopping.aborted) throw new DeliveryShutdownError();
      throw err;
    }
    let sent: boolean;
    try {
      sent = await this.sendNative(e.seq, a, blob, plan);
    } finally {
      release();
    }
    if (!sent) return this.linkLine(e.seq, a);
    return this.advance(e.seq);
  }

  /**
   * Reads and sends one file while holding a file slot; false when the link line stands in for it
   * (see {@link deliverArtifact}).
   */
  private async sendNative(
    seq: number,
    a: ArtifactPayload,
    blob: BlobRef,
    plan: Extract<FileDeliveryPlan, { mode: "native" }>,
  ): Promise<boolean> {
    // the replica stopped while this delivery waited for its slot: hand the job back untouched
    if (this.stopping.aborted) throw new DeliveryShutdownError();
    if (this.lease.lost) throw new DeliveryLostError();
    const sendFile = this.s.sendFile;
    const files = this.s.features.files;
    // cannot happen: the plan is `native` only when both exist (narrows the types)
    if (sendFile === undefined || files === undefined) return false;
    let read: Awaited<ReturnType<typeof readArtifactCapped>>;
    try {
      // the read stops with the replica: nothing has reached the platform yet
      read = await readArtifactCapped(
        (signal) => this.d.blobs.open(this.s.row.orgId, blob, { signal }),
        plan.cap,
        AbortSignal.any([this.stopping, AbortSignal.timeout(FILE_CALL_TIMEOUT_MS)]),
      );
    } catch (err) {
      if (this.stopping.aborted) throw new DeliveryShutdownError();
      throw err;
    }
    if (this.stopping.aborted) throw new DeliveryShutdownError();
    if (read.kind !== "ok") {
      const meta = { conversationId: this.conversationId, seq, reason: read.kind };
      if (read.kind === "too_large")
        this.d.log.info("channel file over the cap sent as a link", meta);
      else this.d.log.warn("channel file unreadable, sent as a link", meta);
      return false;
    }
    if (this.threadPending) {
      await this.send({ text: fileRootText(a.name, this.locale) }, this.key(seq, "-root"));
    }
    const file = {
      name: pluginFileName(a.name),
      contentType: a.contentType,
      kind: fileKind(a.contentType, read.data.byteLength, files),
      data: read.data,
    };
    // As before a card send (recordCard): a read of up to 120 s can outlast the lease; a new holder
    // then delivers this event, so do not post the file a second time
    if (this.lease.lost) throw new DeliveryLostError();
    try {
      // Not aborted on shutdown: an upload cut off midway may already have reached the platform,
      // and the retry posts it again on platforms without idempotent uploads (Slack, Telegram).
      // It finishes or times out (FILE_CALL_TIMEOUT_MS); one longer than the stop budget is
      // abandoned with the process and comes back by stalled detection, the window spec §4.6
      // accepts for a crash between send and advance.
      await sendFile(this.target, file, this.key(seq), this.locale);
    } catch (err) {
      if (!isChannelSendError(err) || err.retryable) throw err;
      if (err.reason === "too_large") {
        this.d.log.info("channel file refused as too large, sent as a link", {
          conversationId: this.conversationId,
          seq,
        });
        return false;
      }
      if (err.reason === "rejected" || err.reason === undefined) {
        await this.d.writes.recordError(this.s.row.id, this.redact(errMsg(err)));
        return false;
      }
      throw err;
    }
    return true;
  }

  /** The line standing in for a file that is not sent natively, then the advance past its event. */
  private async linkLine(seq: number, a: ArtifactPayload): Promise<void> {
    const text = fileLinkText({
      name: a.name,
      size: a.size,
      artifactId: a.artifactId,
      conversationId: this.conversationId,
      base: this.base,
      locale: this.locale,
      product: this.product(),
    });
    await this.send({ text }, this.key(seq, "-link"));
    return this.advance(seq);
  }

  /**
   * Sends the (pending) question card of `questionId` for the event at `seq` (or the web hint). A
   * sub-agent's question (`child` = its conversation) links to the parent with the child open, as
   * its approvals' `conversationPath` does.
   */
  private async questionCardAt(
    seq: number,
    questionId: string,
    form: InputForm,
    child?: string,
  ): Promise<void> {
    if (this.base === undefined) {
      await this.send({ text: phrase("handleOnWeb", this.locale, this.product()) }, this.key(seq));
      return this.advance(seq);
    }
    // the person can skip the conversation's own question by replying; a sub-agent's question
    // stays answerable on its card only (reply-while-question spec §4.3)
    const textReply =
      child === undefined ? (this.target.chatType === "dm" ? "plain" : "mention") : undefined;
    const card = questionCard(
      questionId,
      form,
      "pending",
      this.questionUrl(this.base, child),
      null,
      textReply,
    );
    await this.recordCard("question", card.id);
    const { messageId } = await this.send(
      cardMessage(phrase("questionTitle", this.locale), card),
      this.key(seq),
    );
    return this.advance(seq, { card: { kind: "question", id: card.id, messageId } });
  }

  /**
   * Updates the cards this connection sent in this conversation for a finished sub-agent's
   * approvals and questions to their final state, with the idempotency keys the parent's own
   * `approval_decided` / `question_answered` updates use. Returns whether any card was updated.
   */
  private async refreshChildCards(childRunId: string): Promise<boolean> {
    if (this.base === undefined) return false;
    const [approvals, questions] = await Promise.all([
      this.d.db
        .selectFrom("channel_card_messages as m")
        .innerJoin("approvals as a", "a.id", "m.card_id")
        .select("a.id")
        .where("m.conversation_id", "=", this.conversationId)
        .where("m.connection_id", "=", this.s.row.id)
        .where("m.card_kind", "=", "approval")
        .where("a.run_id", "=", childRunId)
        .where("a.status", "!=", "pending")
        .execute(),
      this.d.db
        .selectFrom("channel_card_messages as m")
        .innerJoin("questions as q", "q.id", "m.card_id")
        .select(["q.id", "q.call_id", "q.conversation_id"])
        .where("m.conversation_id", "=", this.conversationId)
        .where("m.connection_id", "=", this.s.row.id)
        .where("m.card_kind", "=", "question")
        .where("q.run_id", "=", childRunId)
        .where("q.status", "!=", "pending")
        .execute(),
    ]);
    let updated = false;
    for (const a of approvals) {
      const at = await this.cardMessageOf("approval", a.id);
      if (!at) continue;
      const card = await approvalCard(this.d, a.id, this.base, this.locale, this.s.redact);
      if (!card) continue;
      await this.replaceCard(
        at,
        cardMessage(card.title, card),
        idempotencyKey(`${this.conversationId}-approval-${card.id}-${card.state}`),
      );
      updated = true;
    }
    for (const row of questions) {
      const at = await this.cardMessageOf("question", row.id);
      if (!at) continue;
      const q = (await this.d.questions.forCall(childRunId, row.call_id)).find(
        (x) => x.id === row.id,
      );
      if (!q || q.status === "pending") continue;
      const card = questionCard(
        q.id,
        q.form,
        q.status,
        this.questionUrl(this.base, row.conversation_id),
        q.answer,
      );
      await this.replaceCard(
        at,
        cardMessage(phrase("questionTitle", this.locale), card),
        idempotencyKey(`${this.conversationId}-question-${card.id}-${card.state}`),
      );
      updated = true;
    }
    return updated;
  }

  /** The web link of a question card: this conversation, with the sub-agent `child` open. */
  private questionUrl(base: string, child?: string): string {
    const url = conversationUrl(base, this.conversationId);
    return child === undefined ? url : `${url}?subagent=${encodeURIComponent(child)}`;
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
        await this.s.update(
          this.target,
          this.draftId,
          { text },
          this.key(seq, `-close-${how}`),
          this.locale,
        );
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

  /**
   * 已发出的卡片消息；不是本连接发的（或在投递目标建立之前）返回 undefined。
   * A row without `message_id` has no message to update. Events are delivered in order, so the
   * card's own event set `message_id` before any later update is handled; a row without one here
   * means the card was never delivered (its event was skipped after repeated failures), so the
   * update is skipped rather than applied to nothing. Only `message_id` decides: `status` is
   * informational, because a replica still on the pre-0039 code fills `message_id` without setting
   * `status`, leaving a delivered card `pending` during a rolling upgrade.
   */
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
    if (!r) return undefined;
    if (r.message_id === null) {
      this.d.log.warn("channel card update skipped: the card was never delivered", {
        conversationId: this.conversationId,
        kind,
        id,
      });
      return undefined;
    }
    return { messageId: r.message_id, target: r.target as ChannelTarget };
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
      await this.s.update(at.target, at.messageId, message, idempotencyKey, this.locale);
    } else {
      await this.s.send(at.target, message, idempotencyKey, this.locale);
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
        await this.s.update(
          this.target,
          this.draftId as string,
          { text },
          this.key(seq),
          this.locale,
        );
      } catch (err) {
        if (!editRejected(err)) throw err;
        // the draft's edit was rejected (too old to edit, content refused): the whole text goes
        // out as a new message, not counted as a poison event
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

  /**
   * A streamed delta: only text received from the step's start (matching `offset`) accumulates;
   * deltas are not logged and do not advance the delivery. With a progress card the text is the
   * card's status line instead of a draft.
   */
  private onDelta(m: Extract<ConversationBusMessage, { kind: "delta" }>): void {
    if (!this.s.features.edit) return;
    const key = `${m.runId}:${m.step}`;
    if (this.finalized.has(key)) return;
    if (m.delta === "step_reset") {
      // 该步重试：此前的文本作废，下一次尝试从 offset 0 重新开始
      this.streaming = { key, text: "", complete: false };
      // the card drops the abandoned attempt's status line at its next refresh
      if (
        this.progressKind === "card" &&
        this.progress?.runId === m.runId &&
        this.progress.endedAt === undefined
      ) {
        this.progressDirty = true;
      }
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
    if (
      this.progressKind === "card" &&
      this.display === "detailed" &&
      this.progress?.runId === m.runId &&
      this.progress.endedAt === undefined
    ) {
      this.progressDirty = true;
    }
  }

  /**
   * 首次有文本时发草稿（先把消息 id 写进 PG 再继续），之后至多每 `max(1s, features.minEditIntervalMs)` 更新一次。
   */
  private async flushDraft(): Promise<void> {
    // a progress card shows the streamed text as its status line: no draft
    if (this.progressKind === "card") return;
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
        await this.s.update(this.target, this.draftId, { text: cur.text }, undefined, this.locale);
      } catch (err) {
        if (!editRejected(err)) throw err;
        // an edit rejected midway: the draft is not edited again, the final text goes out anew
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

  // ---- the progress card (process blocks spec §6.2, §6.3) ----

  /**
   * The progress side of an event on a `card` / `plain` delivery. True when the event is fully
   * handled here (narration, the answer, a handoff, a pinned card); false hands it on to the usual
   * handling (blocking cards, files, run ends) after the progress card took its part.
   */
  private async handleProgress(e: ConversationEvent): Promise<boolean> {
    if (e.type === "run_started") {
      // a manual compaction run has no steps and no answer: no progress for it
      if (e.runId === null || e.payload.trigger === "compact") return false;
      await this.startProgress(e.runId, e.seq, e.createdAt);
      return true;
    }
    const prev = this.progress;
    if (prev === undefined || prev.endedAt !== undefined) return false;
    if (e.runId !== null && e.runId !== prev.runId) return false;
    const next = await this.reduce(prev, e);
    this.progress = next;
    if (next !== prev) this.progressDirty = true;
    switch (e.type) {
      case "assistant_message": {
        // the step's streamed text is over (its status line falls back to the narration)
        const key = `${e.runId}:${e.payload.step}`;
        this.finalized.add(key);
        if (this.streaming?.key === key) {
          this.streaming = undefined;
          this.dirty = false;
        }
        // narration (spec §1.1) shows only as the card's status line; thinking is never sent
        if (hasToolCall(e.payload.content)) return true;
        await this.answer(e.seq, e.runId, e.payload.step, e.payload.content);
        return true;
      }
      case "tool_result":
        // a handoff is a pending action (sent merged after the answer): the card shows it now
        if (e.payload.view?.kind === "handoff") await this.editProgress(e.seq);
        else if (next.pinnedVersion !== prev.pinnedVersion)
          await this.milestone(e.seq, e.createdAt);
        return true;
      case "approval_requested":
      case "question_asked":
      case "approval_decided":
      case "question_answered":
      case "subagent_waiting":
      case "subagent_finished":
        // a wait for a person starts or ends: at once; the blocking card itself follows as usual
        if (next.state !== prev.state) await this.editProgress(e.seq);
        return false;
      case "run_finished":
      case "run_failed":
      case "run_aborted":
        // the event's usual handling follows (the failure message, closing a draft) and advances
        // past it: `last_seq` must not pass the event before what it owes has been sent
        await this.endProgress(e.seq, true);
        return false;
      default:
        return false;
    }
  }

  /**
   * A run starts: an edit channel posts its progress card (a new message, so it notifies), a
   * channel without edits a start message. The card's id and run are written in the same advance
   * as the event, so a replica that takes over edits the same message.
   */
  private async startProgress(runId: string, seq: number, at: Date): Promise<void> {
    // the previous run's final edit may still be pending (throttled or failed retryably): it lands
    // now, with its end event's key, and is marked final, before this run's card takes over
    if (this.progress?.endedAt !== undefined) await this.flushProgress(true);
    const s = initProgress(runId, at.toISOString());
    this.progress = s;
    this.handoffsSent = 0;
    this.progressDirty = false;
    this.progressReposted = false;
    this.progressBroken = false;
    this.progressRetry = undefined;
    this.progressEndSeq = undefined;
    this.progressFinalPending = false;
    this.milestoneAt = null;
    this.milestoneText = undefined;
    if (this.progressKind === "card") {
      const { messageId } = await this.send(
        this.progressMessage(s),
        idempotencyKey(`${this.conversationId}-progress-${runId}`),
      );
      this.lastProgressAt = Date.now();
      await this.advance(seq, { progress: { messageId, runId } });
      this.progressId = messageId;
      return;
    }
    // `brief` on a channel without edits: no start message, only the answer and what blocks
    if (this.display === "detailed")
      await this.send({ text: phrase("runStarted", this.locale) }, this.key(seq));
    await this.advance(seq, { progress: { messageId: null, runId } });
    this.progressId = null;
  }

  /**
   * The answer (a step without a tool call): one new message with the whole text, then the run's
   * handoff links not sent yet, merged into one message, and one advance past both. A draft left by
   * a job without the card (the setting changed mid-run) is finished as before.
   */
  private async answer(
    seq: number,
    runId: string | null,
    step: number,
    content: { type: string; text?: string }[],
  ): Promise<void> {
    let sent = false;
    if (this.draftId !== null) {
      await this.finalize(runId, step, content, seq);
    } else {
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (text.trim() !== "") {
        await this.send({ text }, this.key(seq));
        sent = true;
      }
    }
    if (await this.sendHandoffs(seq)) sent = true;
    if (sent) await this.advance(seq);
  }

  /** The run's handoff links not sent yet, as one message; false when there are none. */
  private async sendHandoffs(seq: number): Promise<boolean> {
    const links = this.progress?.pending.slice(this.handoffsSent) ?? [];
    if (links.length === 0) return false;
    await this.send(handoffsMessage(links, this.locale), this.key(seq, "-handoffs"));
    this.handoffsSent += links.length;
    return true;
  }

  /**
   * The pinned card changed: the progress card shows it at once; a channel without edits gets its
   * text as a milestone message, unless the last one is at most a minute older (by the events' log
   * times, so a replica that takes over decides the same; `milestone_at` is in PG).
   */
  private async milestone(seq: number, at: Date): Promise<void> {
    if (this.progressKind === "card") {
      await this.editProgress(seq);
      return;
    }
    // `brief`: no milestones on a channel without edits
    if (this.display !== "detailed") return;
    const pinned = this.progress?.pinned;
    if (pinned === undefined) return;
    const t = at.getTime();
    if (this.milestoneAt !== null && t - this.milestoneAt <= MILESTONE_INTERVAL_MS) return;
    await this.send({ text: pinned }, this.key(seq, "-milestone"));
    await this.advance(seq, { milestoneAt: at });
    this.milestoneAt = t;
    this.milestoneText = pinned;
  }

  /**
   * The run ended. A run that finished with no answer after its last narration gets that
   * narration as its answer message (process blocks spec §10 Execution rulings), with the handoff
   * links an answer takes along. Then the card is edited down to its finished form, and once that
   * edit is done (or refused for good) `progress_final` is set in the advance past the end event,
   * so a later job leaves the card alone. A channel without edits gets, in `detailed`, the pinned
   * text as a trailing milestone when the last one sent differs (a change the minute throttle
   * held back), and the handoff links no answer took along (a run that failed or stopped first).
   */
  private async endProgress(seq: number, handledNext = false): Promise<void> {
    const s = this.progress;
    const promoted = s === undefined ? undefined : promotedAnswer(s);
    let sent = false;
    if (
      this.progressKind === "plain" &&
      this.display === "detailed" &&
      s?.pinned !== undefined &&
      s.pinned !== this.milestoneText
    ) {
      await this.send({ text: s.pinned }, this.key(seq, "-milestone"));
      this.milestoneText = s.pinned;
      sent = true;
    }
    if (promoted !== undefined) {
      await this.send({ text: promoted }, this.key(seq, "-answer"));
      sent = true;
    }
    if (this.progressKind === "card") {
      if (promoted !== undefined && (await this.sendHandoffs(seq))) sent = true;
      this.progressEndSeq = seq;
      if (await this.editProgress(seq)) {
        // the final mark is written by the advance that passes the event
        if (handledNext) this.progressFinalPending = true;
        else await this.advance(seq, { progressFinal: true });
      } else if (sent && !handledNext) await this.advance(seq);
      return;
    }
    if (await this.sendHandoffs(seq)) sent = true;
    if (sent && !handledNext) await this.advance(seq);
  }

  /** Folds one event into the state; a step's tool labels are looked up first. */
  private async reduce(s: ProgressState, e: ConversationEvent): Promise<ProgressState> {
    if (e.type === "assistant_message") {
      const keys = e.payload.content.flatMap((b) =>
        b.type === "tool_call" && !this.toolInfos.has(b.name) ? [b.name] : [],
      );
      if (keys.length > 0) {
        const infos = await toolInfo(
          { db: this.d.db, registry: this.d.registry },
          this.s.row.orgId,
          keys,
        );
        for (const k of keys)
          this.toolInfos.set(
            k,
            infos.find((i) => i.key === k),
          );
      }
    }
    return reduceProgress(s, e, (key, input) => this.stepLabel(key, input), this.base);
  }

  /** A step as the approval card names a call: the tool's title and key argument, redacted. */
  private stepLabel(key: string, input: unknown): string {
    const info = this.toolInfos.get(key);
    const line = callSummary({ summary: null, input }, info, this.locale, this.s.redact);
    return line !== "" ? line : (info?.tool ?? key);
  }

  /**
   * Rebuilds the state of the run whose card this delivery edits (`progress_run_id`) by folding
   * its events from its `run_started` up to `last_seq`, so a job on any replica continues the same
   * card. The handoff links an answer took along count as sent.
   */
  private async rebuildProgress(runId: string, final: boolean): Promise<void> {
    const start = await this.d.db
      .selectFrom("conversation_events")
      .select("seq")
      .where("conversation_id", "=", this.conversationId)
      .where("run_id", "=", runId)
      .where("type", "=", "run_started")
      .executeTakeFirst();
    if (!start) return;
    let s: ProgressState | undefined;
    let handoffs = 0;
    // the milestones a channel without edits sent follow from the log times alone: replayed here
    let milestoneAt: number | null = null;
    let milestoneText: string | undefined;
    let after = Number(start.seq) - 1;
    let done = false;
    while (!done) {
      const evs = await this.d.eventLog.readAfter(this.conversationId, after, PAGE);
      done = evs.length < PAGE;
      for (const e of evs) {
        // later events are delivered by this job as usual
        if (e.seq > this.seen) {
          done = true;
          break;
        }
        after = e.seq;
        if (e.type === "run_started") {
          if (e.runId === runId) s = initProgress(runId, e.createdAt.toISOString());
          continue;
        }
        if (s === undefined || s.endedAt !== undefined) continue;
        const before: ProgressState = s;
        s = await this.reduce(s, e);
        if (s.endedAt !== undefined) this.progressEndSeq = e.seq;
        const answered =
          e.type === "assistant_message" && e.runId === runId && !hasToolCall(e.payload.content);
        const ended =
          s.endedAt !== undefined &&
          (this.progressKind === "plain" || promotedAnswer(s) !== undefined);
        if (answered || ended) handoffs = s.pending.length;
        if (s.pinnedVersion !== before.pinnedVersion && e.type === "tool_result") {
          const t = e.createdAt.getTime();
          if (milestoneAt === null || t - milestoneAt > MILESTONE_INTERVAL_MS) {
            milestoneAt = t;
            milestoneText = s.pinned;
          }
        }
        if (s.endedAt !== undefined && s.pinned !== undefined) milestoneText = s.pinned;
      }
    }
    this.progress = s;
    this.handoffsSent = handoffs;
    this.milestoneText = milestoneText;
    // one refresh: a previous job may have died (or failed retryably) before its edit; an ended
    // run's card only while its final edit may not have landed
    this.progressDirty = s !== undefined && !(s.endedAt !== undefined && final);
  }

  /** The progress card message for the state, with the step being streamed as its status line. */
  private progressMessage(s: ProgressState): OutboundMessage {
    const cur = this.streaming;
    const streamed =
      cur?.complete && cur.key.startsWith(`${s.runId}:`) && !this.finalized.has(cur.key)
        ? statusLine(cur.text)
        : undefined;
    const card = progressCard(streamed !== undefined ? { ...s, status: streamed } : s, {
      base: this.base as string,
      conversationId: this.conversationId,
      locale: this.locale,
      mode: this.display,
      now: Date.now(),
    });
    return progressCardMessage(this.s.features, card, this.locale);
  }

  /**
   * Edits the progress card to the current state (`seq`: the event that changed it, for the
   * idempotency key; none for a throttled refresh). True when the card needs nothing more for
   * this state: the edit landed, or the platform refused it for good. A retryable failure (rate
   * limit, network) leaves the card dirty for the next interval instead of failing the job, so
   * blocking cards and the answer still go out. A rejected edit (message too old, content
   * refused) of a running card posts the card again once per run, recording the new message's id
   * and the re-post (`progress_reposted`) in one write; after that, and always for an ended
   * card, a rejection leaves the card as it is. The re-post's idempotency key derives from the
   * rejected message, so a job that re-posts the same rejected card again (the first one died
   * before its write) reuses it.
   */
  private async editProgress(seq: number | undefined): Promise<boolean> {
    const s = this.progress;
    if (this.progressKind !== "card" || s === undefined || this.progressId === null) return true;
    if (this.progressBroken) return true;
    this.progressDirty = false;
    this.lastProgressAt = Date.now();
    const message = this.progressMessage(s);
    const key = seq === undefined ? undefined : this.key(seq, "-progress");
    const rejected = this.progressId;
    try {
      await this.s.update(this.target, rejected, message, key, this.locale);
      this.progressRetry = undefined;
      return true;
    } catch (err) {
      if (!isChannelSendError(err) || err.retryable) {
        // the card catches up at the next interval; the delivery goes on
        this.progressDirty = true;
        this.progressRetry = err instanceof Error ? err : new Error(String(err));
        this.d.log.warn("channel progress edit failed; retrying at the next interval", {
          conversationId: this.conversationId,
          error: this.redact(errMsg(err)),
        });
        return false;
      }
      if (!editRejected(err)) throw err;
      this.d.log.warn("channel progress edit rejected", {
        conversationId: this.conversationId,
        reposted: this.progressReposted,
        ended: s.endedAt !== undefined,
        error: this.redact(errMsg(err)),
      });
    }
    this.progressRetry = undefined;
    // an ended card is not worth a new message: the answer and any failure notice are out already
    if (this.progressReposted || s.endedAt !== undefined) {
      this.progressBroken = true;
      return true;
    }
    this.progressReposted = true;
    const { messageId } = await this.send(
      message,
      idempotencyKey(`${this.conversationId}-progress-${s.runId}-again-${rejected}`),
    );
    // fenced like the draft id: only while this delivery still owns `last_seq` and the run
    const r = await this.d.db
      .updateTable("channel_deliveries")
      .set({ progress_message_id: messageId, progress_reposted: true, updated_at: new Date() })
      .where("conversation_id", "=", this.conversationId)
      .where("last_seq", "=", String(this.persisted))
      .where("progress_run_id", "=", s.runId)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) throw new DeliveryLostError();
    this.progressId = messageId;
    return true;
  }

  /**
   * A throttled refresh of the card: at most every `max(1s, features.minEditIntervalMs)`, like the
   * streaming draft; `force` ignores the interval (the job is about to end). An ended run's card
   * is dirty only when its final edit has not landed: it is edited with the end event's key, then
   * marked final (a write fenced like the re-post's).
   */
  private async flushProgress(force: boolean): Promise<void> {
    if (this.progressKind !== "card" || !this.progressDirty) return;
    const interval = Math.max(DRAFT_INTERVAL_MS, this.s.features.minEditIntervalMs ?? 0);
    if (!force && Date.now() - this.lastProgressAt < interval) return;
    const s = this.progress;
    if (s?.endedAt === undefined) {
      await this.editProgress(undefined);
      return;
    }
    if (!(await this.editProgress(this.progressEndSeq))) return;
    const r = await this.d.db
      .updateTable("channel_deliveries")
      .set({ progress_final: true, updated_at: new Date() })
      .where("conversation_id", "=", this.conversationId)
      .where("last_seq", "=", String(this.persisted))
      .where("progress_run_id", "=", s.runId)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) throw new DeliveryLostError();
  }
}
