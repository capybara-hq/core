import type { ZodTypeAny } from "zod";
import type { CardAction, OutboundMessage } from "./cards.js";

/** 消息的投递目标。 */
export interface ChannelTarget {
  chatId: string;
  threadId?: string;
  chatType: "dm" | "group";
}

/**
 * 入站事件的发言人 / 点击者。`displayName`、`avatarUrl` 为平台上的显示名与头像（拿得到就带）：内核把显示名
 * 用在绑定确认页（没有时回落到 externalId）。`tenantId` 与连接的租户不同的人（外部联系人、共享频道里的
 * 其他企业）内核只允许绑定，不按匿名访客处理。
 */
export interface InboundSender {
  externalId: string;
  tenantId: string;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * 渠道交给内核的入站事件。插件的约定：
 * - M4 只处理文本：附件、图片、文件等忽略（消息只有附件时不发事件）；
 * - 用户编辑、撤回 / 删除消息不发事件（忽略）；
 * - `text` 里去掉 @ 机器人的部分（`mentionsBot` 另行说明是否 @ 了机器人）；
 * - `card_action`：`messageId` 为卡片所在消息的 id；群聊里必须带 `target.threadId`（卡片所在话题），
 *   内核据此判断匿名访客能否处理该卡片，缺了按不能处理。
 */
export type InboundEvent =
  | {
      type: "message";
      messageId: string;
      target: ChannelTarget;
      sender: InboundSender;
      text: string;
      mentionsBot: boolean;
    }
  | {
      type: "card_action";
      target: ChannelTarget;
      messageId: string;
      sender: InboundSender;
      action: CardAction;
    }
  /** 平台推送人员变动的提示，内核据此触发通讯录同步。 */
  | { type: "directory_changed"; tenantId: string };

export interface ChannelConnectArgs {
  connectionId: string;
  /** 已按 connectionSchema 校验，含密钥。 */
  config: unknown;
  /**
   * 把入站事件交给内核。内核只做去重并把事件持久地排进队列（很快，不在这里处理消息），resolve 即表示内核已经
   * 可靠地收下了这条事件：插件**在它 resolve 之后**才向平台确认（ack）；reject 时**不要**确认，让平台重投
   * （内核按消息 id 去重，重投不会重复处理）；插件自己不必重试 `onEvent`。
   */
  onEvent(e: InboundEvent): Promise<void>;
  signal: AbortSignal;
}

export interface ChannelSendArgs {
  config: unknown;
  target: ChannelTarget;
  /**
   * 消息内容。`text` 超过平台单条长度上限时由插件自行拆成多条按序发送，返回**最后一条**的消息 id
   * （内核之后编辑的是这条）。
   */
  message: OutboundMessage;
  signal: AbortSignal;
  /** 连接所属组织的界面语言：插件自己渲染的文案（卡片按钮、降级文本里的固定词）按它选择。 */
  locale: "zh" | "en";
  /**
   * 幂等键（可选）：不超过 40 个 `[A-Za-z0-9_-]` 字符，同一条逻辑消息的每次重试（崩溃后其他副本续投、
   * 可重试失败后重发）都相同——内核由「会话 + 事件 seq」或「卡片 + 状态」稳定哈希得到。平台支持幂等发送
   * （如飞书的 `uuid`）时插件应原样透传或按平台要求映射，以免重复消息；不支持的平台忽略即可。
   */
  idempotencyKey?: string;
}

/** 渠道实现（bot 用渠道连接配置）。 */
export interface Channel {
  /** 渠道连接配置的 schema；密钥字段用 secret()。 */
  connectionSchema: ZodTypeAny;
  /**
   * `minEditIntervalMs`：平台允许的同一条消息两次编辑的最小间隔；内核流式草稿的更新间隔取
   * `max(1000, minEditIntervalMs)`。
   */
  features: { cards: boolean; edit: boolean; threads: boolean; minEditIntervalMs?: number };
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
 * 不可重试失败的原因（`ChannelSendError.reason`），内核据此处理：
 * - `auth`：凭据失效 / 权限被收回 → 记连接 `last_error`，停止该会话本轮的投递；
 * - `target_gone`：机器人被移出群、会话不存在 → 停止该会话本轮的投递，不计入毒事件；
 * - `rejected`（内容被平台拒绝）、`too_large`（拆分后仍超限，如卡片过大）→ 按同一事件失败计数，满 3 次跳过它。
 * 未给出原因的按 `rejected` 处理。
 */
export type ChannelSendFailure = "auth" | "target_gone" | "rejected" | "too_large";

/**
 * 渠道发送 / 更新消息失败的分类：`retryable` 为 true（限流、平台 5xx、网络）时内核退避后重试，
 * `retryAfterMs` 为平台给出的建议等待时长；为 false 时按 `reason`（见 {@link ChannelSendFailure}）处理。
 * 编辑流式草稿不可重试地失败（`auth` / `target_gone` 除外）时，内核改为把完整文本作为新消息发出。
 * 消息里不要带凭据。
 */
export class ChannelSendError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly reason?: ChannelSendFailure;

  constructor(
    message: string,
    opts: {
      retryable: boolean;
      retryAfterMs?: number;
      reason?: ChannelSendFailure;
      cause?: unknown;
    },
  ) {
    super(message, "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "ChannelSendError";
    this.retryable = opts.retryable;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.reason !== undefined) this.reason = opts.reason;
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
