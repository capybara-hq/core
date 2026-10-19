import type { ZodTypeAny } from "zod";
import type { CardAction, OutboundMessage } from "./cards.js";

/** 消息的投递目标。 */
export interface ChannelTarget {
  chatId: string;
  threadId?: string;
  chatType: "dm" | "group";
}

/** 渠道交给内核的入站事件。 */
export type InboundEvent =
  | {
      type: "message";
      messageId: string;
      target: ChannelTarget;
      sender: { externalId: string; tenantId: string };
      text: string;
      mentionsBot: boolean;
    }
  | {
      type: "card_action";
      target: ChannelTarget;
      messageId: string;
      sender: { externalId: string; tenantId: string };
      action: CardAction;
    }
  /** 平台推送人员变动的提示，内核据此触发通讯录同步。 */
  | { type: "directory_changed"; tenantId: string };

export interface ChannelConnectArgs {
  connectionId: string;
  /** 已按 connectionSchema 校验，含密钥。 */
  config: unknown;
  onEvent(e: InboundEvent): Promise<void>;
  signal: AbortSignal;
}

export interface ChannelSendArgs {
  config: unknown;
  target: ChannelTarget;
  message: OutboundMessage;
  signal: AbortSignal;
  /**
   * 幂等键（可选）：内核对同一条逻辑消息的重试（崩溃后其他副本续投、可重试失败后重发）传同一个键——
   * 普通消息为 `"<会话 id>-<事件 seq>"`，卡片状态更新为每张卡片每个状态一个固定键。平台支持幂等发送
   * （如飞书的 `uuid`）时插件应透传它，以免重复消息；不支持的平台忽略即可。
   */
  idempotencyKey?: string;
}

/** 渠道实现（bot 用渠道连接配置）。 */
export interface Channel {
  /** 渠道连接配置的 schema；密钥字段用 secret()。 */
  connectionSchema: ZodTypeAny;
  features: { cards: boolean; edit: boolean; threads: boolean };
  verify(args: {
    config: unknown;
    signal: AbortSignal;
  }): Promise<{ botUserId: string; botName: string; tenantId: string }>;
  /** 长连接循环：signal 中止时返回；断线自行重连。 */
  connect(args: ChannelConnectArgs): Promise<void>;
  /** 失败时抛 {@link ChannelSendError} 说明能否重试；其他异常内核按可重试处理（次数有限）。 */
  send(args: ChannelSendArgs): Promise<{ messageId: string }>;
  /** features.edit 为 false 的渠道不会被调用。失败语义同 send。 */
  update(args: ChannelSendArgs & { messageId: string }): Promise<void>;
}

/**
 * 渠道发送 / 更新消息失败的分类：`retryable` 为 true（限流、平台 5xx、网络）时内核退避后重试，
 * `retryAfterMs` 为平台给出的建议等待时长；为 false（消息被拒、机器人被移出群、凭据失效等）时内核
 * 记下连接的 `last_error` 并停止该会话本轮的投递。消息里不要带凭据。
 */
export class ChannelSendError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { retryable: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "ChannelSendError";
    this.retryable = opts.retryable;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

/** 鸭子类型判断（不用 instanceof），兼容插件自带另一份 plugin-sdk 副本的情况。 */
export function isChannelSendError(e: unknown): e is ChannelSendError {
  return (
    e instanceof Error &&
    e.name === "ChannelSendError" &&
    typeof (e as { retryable?: unknown }).retryable === "boolean"
  );
}
