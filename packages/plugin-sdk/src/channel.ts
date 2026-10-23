import type { ZodTypeAny } from "zod";
import type { CardAction, OutboundMessage } from "./cards.js";

/**
 * 消息的投递目标。群聊里的 `threadId` 是话题**根消息的 `messageId`**（内核用它把同一话题归到一个会话，
 * 回复也投到这个话题）：Slack 为插件所定义的根消息 `messageId`（如 `<频道>:<ts>`，ts 即回复的
 * `thread_ts`）；飞书为根消息的 `message_id`（`root_id`，`om_…`），**不是** `thread_id`（`omt_…`）。私聊不带。
 */
export interface ChannelTarget {
  chatId: string;
  threadId?: string;
  chatType: "dm" | "group";
}

/**
 * 入站事件的发言人 / 点击者。`tenantId` 为发言人所属企业：Slack 为 team id（Enterprise Grid 下是 team，
 * 不是 enterprise），飞书为 `tenant_key`；与连接的租户（`verify` 返回的 `tenantId`，同一口径）不同的人
 * （外部联系人、共享频道里的其他企业）内核只允许绑定，不按匿名访客处理。`displayName`、`avatarUrl` 为平台上的
 * 显示名与头像（拿得到就带）：内核把显示名用在绑定确认页（没有时回落到 externalId）。
 */
export interface InboundSender {
  externalId: string;
  tenantId: string;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * 渠道交给内核的入站事件。插件的约定：
 * - `message.messageId` 在本连接内唯一（内核按它去重）；
 * - M4 只处理文本：附件、图片、文件等忽略（消息只有附件时不发事件）；
 * - 用户编辑、撤回 / 删除消息不发事件（忽略）；
 * - `text` 里去掉 @ 机器人的部分（`mentionsBot` 另行说明是否 @ 了机器人）；
 * - `card_action`：`messageId` 为卡片所在消息的 id（同一张卡片的多次点击相同）；`eventId` 为平台给这次点击的
 *   唯一 id（拿得到就带，本连接内唯一：内核按它去重平台重投）；群聊里 `target.threadId` 拿得到就带，
 *   拿不到时内核取发出该卡片时记下的话题。
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
      /** 平台给这次点击的唯一 id（如飞书回调的 event_id、Slack 的 trigger / action 时间戳组合）。 */
      eventId?: string;
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
   * 可靠地收下了这条事件：插件**在它 resolve 之后**才向平台确认（ack）；reject 时**不要**确认，让平台重投；
   * 插件自己不必重试 `onEvent`。去重范围：`message` 按 `messageId`、带 `eventId` 的 `card_action` 按 `eventId`
   * （各保留 24 小时）——重投只处理一次；不带 `eventId` 的 `card_action` 不去重（每次都处理，重复的审批 /
   * 回答由内核回「已处理」）；`directory_changed` 不去重（同步任务本身按分钟合并）。
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

/**
 * An inbound webhook request as the kernel received it on `POST /channels/webhook/<connectionId>`.
 * `headers` names are lowercase (repeated headers joined with `, `; cookies are dropped); `body` is
 * the raw request bytes, unparsed, so the plugin can verify signatures over them; `receivedAt` is the
 * kernel's receive time in epoch milliseconds (use it for timestamp replay checks).
 */
export interface ChannelWebhookRequest {
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  receivedAt: number;
}

/** An HTTP response the kernel writes back to the platform as is. */
export interface ChannelWebhookResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * What the plugin made of a webhook request:
 * - `respond`: reply directly without any event (URL verification challenge and the like);
 * - `events`: hand these events to the kernel, which dedupes and enqueues them like the long
 *   connection's `onEvent` and replies `ack` only after every one resolved; if any rejects, the
 *   kernel replies 503 so the platform redelivers (dedupe makes the redelivery safe);
 *   an empty list just replies `ack` (ignored events are still acknowledged);
 * - `reject`: the request is not genuine (bad signature, stale timestamp, malformed): reply this
 *   status and enqueue nothing.
 */
export type ChannelWebhookResult =
  | { kind: "respond"; response: ChannelWebhookResponse }
  | { kind: "events"; events: InboundEvent[]; ack: ChannelWebhookResponse }
  | { kind: "reject"; status: 400 | 401 | 403 };

/**
 * Optional webhook inbound mode (`Channel.webhook`). Signature verification, decryption and
 * timestamp replay protection all happen here: the kernel knows no platform formats, applies no
 * auth on the route, and only calls this for connections in webhook mode. `config` is the
 * connection config (validated against `connectionSchema`, secrets included). Must be quick: the
 * platform's ack deadline is a few seconds, and `signal` aborts when the platform hangs up.
 */
export interface ChannelWebhook {
  handle(args: {
    connectionId: string;
    config: unknown;
    request: ChannelWebhookRequest;
    signal: AbortSignal;
  }): Promise<ChannelWebhookResult>;
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
  /**
   * features.edit 为 false 的渠道不会被调用。失败语义同 send。新文本超过平台单条上限、无法改成一条时
   * 抛不可重试的 {@link ChannelSendError}（`reason: "too_large"`）：内核改为把完整文本作为新消息 `send`
   * （由插件拆分）。
   */
  update(args: ChannelSendArgs & { messageId: string }): Promise<void>;
  /**
   * Optional webhook inbound (see {@link ChannelWebhook}). Only connections of plugins that
   * implement it can be switched from the default long connection to webhook mode; a connection in
   * webhook mode gets no `connect` call.
   */
  webhook?: ChannelWebhook;
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
