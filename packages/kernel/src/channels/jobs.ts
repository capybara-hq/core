import { createHash, randomUUID } from "node:crypto";
import type { ChannelTarget, InboundEvent, Logger } from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { Queue } from "bullmq";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { OUTBOX_JOBS } from "../infra/outbox/registry.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import {
  CHANNEL_QUEUE_NAME,
  DELIVER_JOB,
  type DeliverJobData,
  deliverJobId,
  oweDelivery,
  RESUME_JOB,
  type ResumeJobData,
  resumeJobId,
} from "./deliver-job.js";

export {
  CHANNEL_QUEUE_NAME,
  DELIVER_JOB,
  type DeliverJobData,
  deliverJobId,
  oweDelivery,
  RESUME_JOB,
  type ResumeJobData,
  resumeJobId,
} from "./deliver-job.js";

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
export const DELIVER_ATTEMPTS = OUTBOX_JOBS.deliver.opts.attempts;

/** 入站任务（Ruling A21）：插件 `onEvent` 收到的事件，原样排进队列由 worker 处理。 */
export interface InboundJobData {
  connectionId: string;
  event: InboundEvent;
}

export type ChannelJobData = DeliverJobData | InboundJobData | ResumeJobData;

/** 入站任务名。 */
export const INBOUND_JOB = "inbound";
/**
 * BullMQ 优先级（数字越小越先）：入站任务先于出站投递任务——投递任务可能占着并发槽等输出，
 * 用户发来的消息不能排在它们后面。
 */
export const INBOUND_PRIORITY = 1;
export const DELIVER_PRIORITY = OUTBOX_JOBS.deliver.opts.priority;
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
 * role. A delivery is owed (transactional outbox spec §8.1): every event append of a conversation
 * with a channel target adds its deliver job to the outbox in the append's transaction (a reply, an
 * approval decision, a question answer, a wait stop all append), and {@link bind} owes the first
 * one with the target. The direct {@link enqueue} is left for hints and catch-ups: a run starting
 * here (`run.started`, so its streaming drafts start at once), a finished delivery job's re-check,
 * a card click's thread and a connection that can deliver again.
 */
@Injectable()
export class ChannelJobs implements OnApplicationShutdown {
  /** Stopped (the stop's channel-outbound phase): enqueues do nothing, inbound enqueues throw. */
  private closed = false;
  private readonly unsubscribe: (() => void)[];

  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(getQueueToken(CHANNEL_QUEUE_NAME)) private readonly queue: Queue<ChannelJobData>,
    @Inject(KernelEvents) events: Pick<KernelEvents, "on">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn" | "error">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {
    queue.on("error", (err) => this.log.error("channel outbound queue error", { err }));
    this.unsubscribe = [
      events.on("run.started", ({ conversationId }) => this.enqueueSoon(conversationId)),
    ];
  }

  /** Unsubscribes after the stop phases: events emitted while they drain are still handled. */
  onApplicationShutdown(): void {
    for (const off of this.unsubscribe) off();
  }

  /**
   * Makes `target` (on `connectionId`) the conversation's delivery target and owes its delivery
   * from the current log position, in one transaction. A new target starts delivering after
   * `seq` (the message that bound it); a known one keeps its progress. The conversation row is
   * locked first, as an append locks it: an append either committed before (its events are below
   * the owed position) or reads the target (and owes its own job).
   */
  @Transactional()
  async bind(
    orgId: string,
    conversationId: string,
    connectionId: string,
    target: ChannelTarget,
    seq: number,
  ): Promise<void> {
    const conv = await this.db
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirst();
    if (!conv) return;
    await this.db
      .insertInto("channel_deliveries")
      .values({
        conversation_id: conversationId,
        connection_id: connectionId,
        target: JSON.stringify(target),
        last_seq: seq,
      })
      .onConflict((oc) =>
        oc.column("conversation_id").doUpdateSet({
          connection_id: connectionId,
          target: JSON.stringify(target),
          updated_at: new Date(),
        }),
      )
      .execute();
    await oweDelivery(this.outbox, { conversationId, orgId, seq: Number(conv.last_seq) });
  }

  /** 会话有 IM 投递目标时排一个出站任务，不等入队完成；失败只记日志。 */
  private enqueueSoon(conversationId: string): void {
    this.enqueue(conversationId).catch((err) =>
      this.log.warn("cannot enqueue channel delivery", { conversationId, err }),
    );
  }

  /**
   * A hint (not owed work, see the class): a delivery job for a conversation with an IM target (one
   * per log position; `followUp` gets a fresh id); does nothing once closed.
   */
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
        ...OUTBOX_JOBS.deliver.opts,
        jobId: opts.followUp
          ? followUpJobId(conversationId, Number(row.last_seq))
          : deliverJobId(conversationId, Number(row.last_seq)),
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
   * Owes the catch-up of a connection that can deliver again in the caller's transaction (the
   * update that re-enabled it or rotated its credentials while active): the deliveries that ran
   * while it could not deliver have ended, and nothing else finds the conversations lagging the log.
   * `at` is the connection row's new `updated_at`.
   */
  oweResume(connectionId: string, orgId: string, at: Date): Promise<boolean> {
    return this.outbox.add<ResumeJobData>({
      queue: CHANNEL_QUEUE_NAME,
      name: RESUME_JOB,
      jobId: resumeJobId(connectionId, at),
      data: { connectionId },
      orgId,
    });
  }

  /**
   * The {@link RESUME_JOB} job: 连接重新可投递（轮换了凭据 / 重新启用）：给该连接投递进度落后于会话日志的会话各排一个出站任务，
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
