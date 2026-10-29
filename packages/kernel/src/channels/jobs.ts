import { createHash, randomUUID } from "node:crypto";
import type { InboundEvent, Logger } from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Queue } from "bullmq";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";

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

/** 可重试失败（限流、5xx、网络、超时）的总尝试次数。 */
export const DELIVER_ATTEMPTS = 8;

export interface DeliverJobData {
  conversationId: string;
}

/** 入站任务（Ruling A21）：插件 `onEvent` 收到的事件，原样排进队列由 worker 处理。 */
export interface InboundJobData {
  connectionId: string;
  event: InboundEvent;
}

export type ChannelJobData = DeliverJobData | InboundJobData;

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

/**
 * The producer side of the channel queue `cap-kernel-channels` (any role): delivery jobs for a
 * conversation with an IM target, inbound jobs (Ruling A21), and the catch-up of a connection that
 * can deliver again. Its consumer is {@link ChannelOutbound} through the `@Processor` of the worker
 * role. Delivery jobs follow the kernel's domain events (spec §3b): every published log advance
 * (`conversation.event-appended`), a run starting here (`run.started`), a stopped wait
 * (`run.wait-stopped`), a decided approval and an answered question (their cards change). Each is
 * lost-tolerant: the next append enqueues again, and a finished delivery job re-checks the log.
 */
@Injectable()
export class ChannelJobs implements OnModuleDestroy {
  /** Stopped (the stop's channel-outbound phase): enqueues do nothing, inbound enqueues throw. */
  private closed = false;
  private readonly unsubscribe: (() => void)[];

  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(getQueueToken(CHANNEL_QUEUE_NAME)) private readonly queue: Queue<ChannelJobData>,
    @Inject(KernelEvents) events: Pick<KernelEvents, "on">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn" | "error">,
  ) {
    queue.on("error", (err) => this.log.error("channel outbound queue error", { err }));
    const soon = ({ conversationId }: { conversationId: string }) =>
      this.enqueueSoon(conversationId);
    this.unsubscribe = [
      events.on("conversation.event-appended", soon),
      events.on("run.started", soon),
      events.on("run.wait-stopped", soon),
      events.on("approval.decided", soon),
      events.on("question.answered", soon),
    ];
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribe) off();
  }

  /** 会话有 IM 投递目标时排一个出站任务，不等入队完成；失败只记日志。 */
  private enqueueSoon(conversationId: string): void {
    this.enqueue(conversationId).catch((err) =>
      this.log.warn("cannot enqueue channel delivery", { conversationId, err }),
    );
  }

  /** 会话有 IM 投递目标时投递一个出站任务（同一日志位置重复调用只排一个）；已关闭时什么都不做。 */
  async enqueue(conversationId: string, opts: { followUp?: boolean } = {}): Promise<void> {
    if (this.closed) return;
    const row = await this.db
      .selectFrom("channel_deliveries")
      .innerJoin("conversations", "conversations.id", "channel_deliveries.conversation_id")
      .select("conversations.last_seq")
      .where("channel_deliveries.conversation_id", "=", conversationId)
      .executeTakeFirst();
    if (!row || this.closed) return;
    await this.queue.add(
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
    if (this.closed) throw new Error("channel outbound queue is closed");
    await this.queue.add(
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
    const rows = await this.db
      .selectFrom("channel_deliveries")
      .innerJoin("conversations", "conversations.id", "channel_deliveries.conversation_id")
      .select("channel_deliveries.conversation_id")
      .where("channel_deliveries.connection_id", "=", connectionId)
      .whereRef("channel_deliveries.last_seq", "<", "conversations.last_seq")
      .execute();
    for (const r of rows) await this.enqueue(r.conversation_id, { followUp: true });
  }

  /** No more jobs from this process (the stop's channel-outbound phase). Idempotent. */
  close(): void {
    this.closed = true;
  }
}
