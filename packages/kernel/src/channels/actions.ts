import type {
  ChannelCard,
  ChannelTarget,
  InboundEvent,
  InboundSender,
} from "@capybara-hq/plugin-sdk";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError, type ErrorCode } from "../errors.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import type { QuestionsService } from "../tools/questions.service.js";
import type { ChannelConnectionRow, ChannelConnections } from "./connections.service.js";
import type { ChannelOutboundScheduler } from "./inbound.js";
import { idempotencyKey } from "./outbound.js";
import { type ChannelLocale, type ChannelPhrase, phrase } from "./phrases.js";
import { findThread, threadKeyOf } from "./threads.js";

type CardActionEvent = Extract<InboundEvent, { type: "card_action" }>;

/** 入站处理的第 3 步（发言人 → 账号；失败时已回复并返回 undefined），由 ChannelInbound 提供。 */
export type SpeakerResolver = (
  connectionId: string,
  row: ChannelConnectionRow,
  sender: InboundSender,
  isGroup: boolean,
  locale: ChannelLocale,
  reply: (key: ChannelPhrase, cards?: ChannelCard[]) => Promise<void>,
) => Promise<{ accountId: string; threadAccount: string | null } | undefined>;

export interface ChannelCardActionsDeps {
  db: KernelDb;
  connections: Pick<ChannelConnections, "row" | "send">;
  approvals: Pick<ApprovalsService, "decide">;
  questions: Pick<QuestionsService, "answer">;
  outbound: ChannelOutboundScheduler;
  resolveSpeaker: SpeakerResolver;
}

/** 授权 / 状态类失败 → 回给点击者的一句话（不改卡片）；其余错误照常抛出。 */
const REPLY_FOR: Partial<Record<ErrorCode, ChannelPhrase>> = {
  "approval.not_found": "cannotHandle",
  "question.not_found": "cannotHandle",
  forbidden: "cannotHandle",
  "approval.already_decided": "alreadyHandled",
  "question.already_answered": "alreadyHandled",
  validation_failed: "invalidAction",
};

/**
 * IM 卡片上的按钮操作（Review Focus 2）：点击者按入站同样的规则映射到账号（未绑定 → 私聊回绑定卡片、群里只提示去私聊），
 * 再以该账号调用 `ApprovalsService.decide` / `QuestionsService.answer`——授权完全由它们判定：
 * 不是审批人 / 不是提问发起人 / 不在该组织 → 回一句「你不能处理这条请求」，卡片不变。
 * 成功后卡片由出站投递按 `approval_decided` / `question_answered` 更新；这里再投递一个出站任务，让续跑的输出接着投到 IM。
 */
export class ChannelCardActions {
  constructor(private readonly deps: ChannelCardActionsDeps) {}

  async handle(connectionId: string, e: CardActionEvent): Promise<void> {
    const { connections } = this.deps;
    const row = await connections.row(connectionId);
    // 连接停用、组织已删除或插件在该组织停用（停用广播与长连接断开之间仍可能有事件到达）：什么都不做
    if (row?.status !== "active" || !row.pluginEnabled) return;
    const { locale } = await readOrgSettings(this.deps.db, row.orgId);
    const a = e.action;
    // Ruling A13：卡片必须是本连接发在这个 chat 里的（防止伪造卡片 id 去处理别处的请求）
    const card = await this.deps.db
      .selectFrom("channel_card_messages")
      .select(["conversation_id", "target"])
      .where("connection_id", "=", connectionId)
      .where("card_kind", "=", a.cardKind)
      .where("card_id", "=", a.cardId)
      .executeTakeFirst();
    const cardTarget = card?.target as ChannelTarget | undefined;
    // Ruling A26：群里的点击拿不到话题时，取发出该卡片时记下的话题（只在同一个 chat 里才借用）
    const target: ChannelTarget =
      e.target.chatType === "group" &&
      e.target.threadId === undefined &&
      cardTarget?.chatId === e.target.chatId &&
      cardTarget.threadId !== undefined
        ? { ...e.target, threadId: cardTarget.threadId }
        : e.target;
    // 有平台事件 id 时回复带幂等键（任务重试不重复回复）；没有时同一张卡片的不同点击无法区分，不带
    const key =
      e.eventId !== undefined ? idempotencyKey(`${connectionId}-${e.eventId}-reply`) : undefined;
    const reply = async (k: ChannelPhrase, cards?: ChannelCard[]) => {
      await connections.send(
        connectionId,
        target,
        { text: phrase(k, locale), ...(cards !== undefined && { cards }) },
        key,
      );
    };
    const isGroup = e.target.chatType === "group";
    const who = await this.deps.resolveSpeaker(connectionId, row, e.sender, isGroup, locale, reply);
    if (who === undefined) return;
    if (!card || (card.target as ChannelTarget).chatId !== e.target.chatId) {
      await reply("cannotHandle");
      return;
    }
    // 匿名访客共用一个账号：只能处理自己话题里的卡片，且不能留下「本会话 / 以后都允许」的授权
    const anonymous = who.threadAccount === null;
    if (anonymous) {
      const own = await findThread(this.deps.db, {
        connectionId,
        chatId: e.target.chatId,
        threadKey: threadKeyOf(target, e.sender.externalId, e.messageId),
        accountId: null,
      });
      if (own !== card.conversation_id) {
        await reply("cannotHandle");
        return;
      }
    }
    let conversationId: string;
    try {
      if (a.cardKind === "approval" && (a.action === "approve" || a.action === "deny")) {
        const scope = anonymous ? "once" : a.scope;
        const r = await this.deps.approvals.decide(row.orgId, a.cardId, who.accountId, {
          decision: a.action,
          ...(scope !== undefined && { scope }),
        });
        conversationId = r.conversationId;
      } else if (a.cardKind === "question" && a.action === "answer") {
        const r = await this.deps.questions.answer(
          a.cardId,
          who.accountId,
          a.answer ?? {},
          row.orgId,
        );
        conversationId = r.conversationId;
      } else {
        await reply("invalidAction");
        return;
      }
    } catch (err) {
      const key = err instanceof ApiError ? REPLY_FOR[err.code] : undefined;
      if (key === undefined) throw err;
      await reply(key);
      return;
    }
    await this.deps.outbound.enqueue(conversationId);
  }
}
