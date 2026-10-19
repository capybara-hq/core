import type { ChannelCard, ChannelTarget, InboundEvent, Logger } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { ConversationsService } from "../conversations/conversations.service.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { IdentityBinding } from "../identity/binding.js";
import type { ExternalIdentities } from "../identity/external.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import type { QuestionsService } from "../tools/questions.service.js";
import { ChannelCardActions } from "./actions.js";
import type { ChannelConnectionRow, ChannelConnections } from "./connections.service.js";
import { type ChannelLocale, type ChannelPhrase, phrase } from "./phrases.js";
import {
  archiveThread,
  ensureAnonymousGuest,
  findThread,
  insertThread,
  type ThreadKey,
  threadKeyOf,
} from "./threads.js";

/** 入站消息去重键的保留时长（秒）：平台在这段时间内重投同一条消息只处理一次。 */
export const MESSAGE_DEDUPE_TTL_SECONDS = 86_400;

/** 入站消息去重键（Redis 键，不是队列名 / job id，可以含 `:`）。 */
export const messageDedupeKey = (connectionId: string, messageId: string) =>
  `capk:channel-msg:${connectionId}:${messageId}`;

/** 通讯录同步的投递接口（实现见 orgs/directory-sync.ts：按 (组织, 插件) 每分钟去重的维护队列任务）。 */
export interface DirectorySyncScheduler {
  /** 返回值（如 job id）不使用。 */
  enqueue(orgId: string, plugin: string): Promise<unknown>;
}

/** 出站投递的投递接口（实现见 outbound.ts：把会话的新事件按 `channel_deliveries.last_seq` 续投到 IM）。 */
export interface ChannelOutboundScheduler {
  enqueue(conversationId: string): Promise<void>;
}

export interface ChannelInboundDeps {
  db: KernelDb;
  redis: Redis;
  connections: Pick<ChannelConnections, "row" | "send">;
  conversations: Pick<ConversationsService, "create" | "postUserMessage">;
  external: Pick<ExternalIdentities, "findAccount">;
  binding: Pick<IdentityBinding, "createBindToken">;
  directorySync: DirectorySyncScheduler;
  outbound: ChannelOutboundScheduler;
  /** 卡片操作：审批决定与提问回答（授权由这两个服务按点击者映射到的账号判定）。 */
  approvals: Pick<ApprovalsService, "decide">;
  questions: Pick<QuestionsService, "answer">;
  log: Pick<Logger, "warn">;
}

type MessageEvent = Extract<InboundEvent, { type: "message" }>;

/**
 * 渠道入站（插件 `connect` 的 `onEvent`）：
 * 1. 消息按 `capk:channel-msg:<连接>:<消息>` `SET NX` 24 小时去重（处理失败则删掉，平台重投时重试；
 *    写用户消息另带 `clientMessageId = "<连接>:<消息>"`，重试不会重复写）；
 * 2. 群聊未 @ 机器人 → 忽略；
 * 3. 发言人按 `<插件>:<租户>` + externalId 纯查找账号（不建账号、不合并），且须是连接所属组织的活跃成员；
 *    否则按连接的未绑定策略：`bind` → 私聊回绑定卡片（群里只提示去私聊，绑定链接不能发在群里）、
 *    已绑定但非成员回提示；`anonymous` → 仅当绑定的 agent 全组织可见时用该组织的匿名访客，否则回提示。
 *    识别不出发言人时绝不借用连接创建者或任何人的身份；
 * 4. 私聊 `/new` → 归档当前对话行并回「已开始新对话」；
 * 5. 按话题找或建会话，写用户消息，记下投递目标并投递出站任务（Task 11）。
 * `directory_changed` → 投递通讯录同步（Task 12）；`card_action` 见 actions.ts。
 */
export class ChannelInbound {
  private readonly actions: ChannelCardActions;

  constructor(private readonly deps: ChannelInboundDeps) {
    this.actions = new ChannelCardActions({
      db: deps.db,
      connections: deps.connections,
      approvals: deps.approvals,
      questions: deps.questions,
      outbound: deps.outbound,
      resolveSpeaker: (...args) => this.resolveSpeaker(...args),
    });
  }

  async handle(connectionId: string, e: InboundEvent): Promise<void> {
    if (e.type === "directory_changed") {
      const row = await this.deps.connections.row(connectionId);
      if (row?.status === "active") await this.deps.directorySync.enqueue(row.orgId, row.plugin);
      return;
    }
    if (e.type === "card_action") {
      await this.actions.handle(connectionId, e);
      return;
    }
    // 边界情况（已接受）：
    // - 同一条消息的重投在首次处理仍在进行时到达：SET NX 已占住，重投被丢弃；若首次处理随后失败并删掉键，
    //   这条消息就只能等平台下一次重投（平台不再重投则丢失）。
    // - 首次处理在写入用户消息之后失败（如回复发送或 ensureRun 失败）：键被删掉，重投会再走一遍；
    //   用户消息靠 clientMessageId 幂等不会重复，但固定话术 / 卡片回复可能再发一次。
    const key = messageDedupeKey(connectionId, e.messageId);
    const fresh = await this.deps.redis.set(key, "1", "EX", MESSAGE_DEDUPE_TTL_SECONDS, "NX");
    if (fresh !== "OK") return;
    try {
      await this.message(connectionId, e);
    } catch (err) {
      await this.deps.redis.del(key).catch(() => {});
      throw err;
    }
  }

  private async message(connectionId: string, e: MessageEvent): Promise<void> {
    const { db, connections } = this.deps;
    const row = await connections.row(connectionId);
    if (row?.status !== "active") return;
    const isGroup = e.target.chatType === "group";
    if (isGroup && !e.mentionsBot) return;
    const threadKey = threadKeyOf(e.target, e.sender.externalId, e.messageId);
    // 群里回在话题里（新话题以这条消息为根）
    const replyTarget: ChannelTarget = isGroup ? { ...e.target, threadId: threadKey } : e.target;
    const { locale } = await readOrgSettings(db, row.orgId);
    const reply = async (key: ChannelPhrase, cards?: ChannelCard[]) => {
      await connections.send(connectionId, replyTarget, {
        text: phrase(key, locale),
        ...(cards !== undefined && { cards }),
      });
    };

    const speaker = await this.resolveSpeaker(connectionId, row, e.sender, isGroup, locale, reply);
    if (speaker === undefined) return;
    const { accountId, threadAccount } = speaker;

    const k: ThreadKey = {
      connectionId,
      chatId: e.target.chatId,
      threadKey,
      accountId: threadAccount,
    };
    if (!isGroup && e.text.trim().toLowerCase() === "/new") {
      await archiveThread(db, k);
      await reply("newConversation");
      return;
    }

    let conversationId = await findThread(db, k);
    if (conversationId === undefined) {
      let created: string;
      try {
        created = (await this.deps.conversations.create(row.orgId, accountId, row.agentId)).id;
      } catch (err) {
        if (err instanceof ApiError && err.code === "agent.not_found") {
          await reply("agentUnavailable");
          return;
        }
        throw err;
      }
      conversationId = await insertThread(db, k, created);
      if (conversationId !== created) {
        // 同一话题的另一条消息抢先建好了：删掉刚建、还没有任何事件的空会话
        await db
          .deleteFrom("conversations")
          .where("id", "=", created)
          .where("last_seq", "=", "0")
          .execute();
      }
    }
    let seq: number;
    try {
      const event = await this.deps.conversations.postUserMessage(
        row.orgId,
        conversationId,
        accountId,
        { text: e.text, clientMessageId: `${connectionId}:${e.messageId}` },
      );
      seq = event.seq;
    } catch (err) {
      // agent 已对此人不可用（改了可见范围 / 已删除）：会话按不存在处理
      if (err instanceof ApiError && err.code === "conversation.not_found") {
        await reply("agentUnavailable");
        return;
      }
      throw err;
    }
    await db
      .insertInto("channel_deliveries")
      .values({
        conversation_id: conversationId,
        connection_id: connectionId,
        target: JSON.stringify(replyTarget),
        last_seq: seq,
      })
      .onConflict((oc) =>
        oc.column("conversation_id").doUpdateSet({
          connection_id: connectionId,
          target: JSON.stringify(replyTarget),
          updated_at: new Date(),
        }),
      )
      .execute();
    await this.deps.outbound.enqueue(conversationId);
  }

  /**
   * 第 3 步：发言人（或卡片点击者）→ 账号。按 `<插件>:<租户>` + externalId 纯查找，且须是该组织的活跃成员；
   * 否则按连接的未绑定策略回复（绑定卡片只发在私聊里）并返回 undefined。
   * `threadAccount` 为话题行记的账号（匿名访客为 null）。
   */
  async resolveSpeaker(
    connectionId: string,
    row: ChannelConnectionRow,
    sender: { externalId: string; tenantId: string },
    isGroup: boolean,
    locale: ChannelLocale,
    reply: (key: ChannelPhrase, cards?: ChannelCard[]) => Promise<void>,
  ): Promise<{ accountId: string; threadAccount: string | null } | undefined> {
    const { db } = this.deps;
    const source = `${row.plugin}:${sender.tenantId}`;
    const bound = await this.deps.external.findAccount(source, sender.externalId);
    if (bound !== undefined && (await this.isActiveMember(row.orgId, bound))) {
      return { accountId: bound, threadAccount: bound };
    }
    if (row.unboundPolicy === "anonymous") {
      if (!(await this.agentVisibleToOrg(row.orgId, row.agentId))) {
        await reply("anonymousNotAllowed");
        return undefined;
      }
      return { accountId: await ensureAnonymousGuest(db, row.orgId), threadAccount: null };
    }
    if (bound !== undefined) {
      await reply("notMember");
      return undefined;
    }
    if (isGroup) {
      await reply("bindInDm");
      return undefined;
    }
    let url: string;
    try {
      url = await this.deps.binding.createBindToken({
        connectionId,
        identity: {
          source,
          externalId: sender.externalId,
          tenantId: sender.tenantId,
          emailVerified: false,
          displayName: sender.externalId,
        },
      });
    } catch (err) {
      this.deps.log.warn("cannot create channel bind link", { connectionId, err });
      await reply("bindUnavailable");
      return undefined;
    }
    await reply("bindPrompt", [{ kind: "bind", url, text: phrase("bindPrompt", locale) }]);
    return undefined;
  }

  /** 账号是该组织成员且账号未停用。 */
  private async isActiveMember(orgId: string, accountId: string): Promise<boolean> {
    const r = await this.deps.db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("memberships.role")
      .where("memberships.org_id", "=", orgId)
      .where("memberships.account_id", "=", accountId)
      .where("accounts.status", "=", "active")
      .executeTakeFirst();
    return r !== undefined;
  }

  /** 连接绑定的 agent 未删除且可见范围为「全组织」（匿名访客只能用这种 agent）。 */
  private async agentVisibleToOrg(orgId: string, agentId: string): Promise<boolean> {
    const r = await this.deps.db
      .selectFrom("agents")
      .select("id")
      .where("id", "=", agentId)
      .where("org_id", "=", orgId)
      .where("visibility", "=", "org")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return r !== undefined;
  }
}
