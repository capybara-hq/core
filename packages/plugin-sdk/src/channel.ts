import type { ZodTypeAny } from "zod";
import type { CardAction, OutboundMessage } from "./cards.js";

/** `channel@1`：IM 渠道（机器人收发消息、渲染卡片）。 */
export const CHANNEL_CAPABILITY = "channel@1" as const;

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
  send(args: ChannelSendArgs): Promise<{ messageId: string }>;
  /** features.edit 为 false 的渠道不会被调用。 */
  update(args: ChannelSendArgs & { messageId: string }): Promise<void>;
}
