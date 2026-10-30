import { randomUUID } from "node:crypto";
import type {
  ChannelCard,
  ChannelTarget,
  InboundEvent,
  InboundSender,
  Logger,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ConversationsService } from "../conversations/conversations.service.js";
import type { ConversationEvent } from "../conversations/events.js";
import { ApiError } from "../errors.js";
import { IdentityBinding } from "../identity/binding.js";
import { ExternalIdentities } from "../identity/external.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { DirectorySync } from "../orgs/directory-sync.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { parseSlashCommand } from "../skills/invoke.js";
import { ApprovalsService } from "../tools/approvals.service.js";
import { QuestionsService } from "../tools/questions.service.js";
import { ChannelCardActions } from "./actions.js";
import { type ChannelConnectionRow, ChannelConnections } from "./connections.service.js";
import { ChannelJobs, idempotencyKey, inboundJobId } from "./jobs.js";
import { type ChannelLocale, type ChannelPhrase, phrase } from "./phrases.js";
import {
  AnonymousGuests,
  archiveThread,
  findThread,
  insertThread,
  type ThreadKey,
  threadKeyOf,
} from "./threads.js";

/** 入站消息去重键的保留时长（秒）：平台在这段时间内重投同一条消息只处理一次。 */
export const MESSAGE_DEDUPE_TTL_SECONDS = 86_400;

/** Dedupe key states: the enqueue is running (`pending`) or has succeeded (`done`). */
export const DEDUPE_PENDING = "pending";
export const DEDUPE_DONE = "done";
/** A `pending` key outlives a crashed enqueuer only this long, then redeliveries enqueue again. */
export const DEDUPE_PENDING_TTL_SECONDS = 60;
/** 入站消息去重键（Redis 键，不是队列名 / job id，可以含 `:`）。 */
export const messageDedupeKey = (connectionId: string, messageId: string) =>
  `capk:channel-msg:${connectionId}:${messageId}`;

/** 带平台事件 id 的卡片点击的去重键（Ruling A26，Redis 键，可以含 `:`）。 */
export const actionDedupeKey = (connectionId: string, eventId: string) =>
  `capk:channel-act:${connectionId}:${eventId}`;

type MessageEvent = Extract<InboundEvent, { type: "message" }>;

/**
 * 渠道入站（Ruling A21：持久化处理）。
 * - `onEvent`（插件 `connect` 的回调，必须快）：消息按 `capk:channel-msg:<连接>:<消息>` `SET NX` 24 小时去重，
 *   再排一个入站任务（`inbound-<连接>-<消息 id 哈希>`）后返回；入队失败删掉去重键并抛错（插件不确认，平台重投）。
 *   带 `eventId` 的卡片操作同样按 `capk:channel-act:<连接>:<eventId>` 去重（任务 id 由 eventId 哈希，Ruling A26），
 *   不带的直接入队（任务 id 随机）；`directory_changed` 只是投递一个通讯录同步任务，就地完成。
 *   返回即「内核已持久接收」：插件此后才向平台确认。
 * - `handle`（worker 上执行入站任务）：失败抛错由 BullMQ 指数退避重试（共 5 次；插件在本副本未加载时推迟、
 *   回复报 auth / target_gone 时不重试）；写用户消息带 `clientMessageId = "<连接>:<消息>"`，回复带由
 *   `<连接>-<消息 id>-reply` 哈希的幂等键，重试不会重复写 / 重复回复。步骤：
 * 1. 连接停用、所属组织已删除或插件在该组织停用 → 什么都不做；群聊未 @ 机器人 → 忽略；
 * 2. 发言人按 `<插件>:<租户>` + externalId 纯查找账号（不建账号、不合并），且须是连接所属组织的活跃成员；
 *    否则按连接的未绑定策略：`bind` → 私聊回绑定卡片（群里只提示去私聊，绑定链接不能发在群里）、
 *    已绑定但非成员回提示；`anonymous` → 仅当绑定的 agent 全组织可见、且发言人与连接同一租户时用该组织的
 *    匿名访客（外部租户的人只能绑定），否则回提示。识别不出发言人时绝不借用连接创建者或任何人的身份；
 * 3. 私聊 `/new` → 归档当前对话行并回「已开始新对话」；
 * 4. 按话题找或建会话，写用户消息，记下投递目标并投递出站任务（Task 11）。A message whose text
 *    (bot mention stripped) is `/name args` is posted as a skill invocation (phase D spec §9): the
 *    same kernel path as the web, so the skill is resolved among the connection's agent's skills
 *    for the bound person; a refusal (`skill.not_invocable`: unknown, not user-invocable, gone
 *    since; `validation_failed`: over the limits) posts the text as typed, so nothing is lost.
 * `directory_changed` → 投递通讯录同步（Task 12）；`card_action` 见 actions.ts。
 * 边界（已接受）：同一 chat 的连续消息由不同任务并发处理，极少数情况下写入顺序可能与平台顺序不同；
 * 处理在写入用户消息之后失败而重试时，固定话术 / 卡片回复可能再发一次。
 */
@Injectable()
export class ChannelInbound {
  private readonly actions: ChannelCardActions;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set">,
    /** The two-state dedupe markers (`lease` / `holderOf` / `releaseIf`; keys unchanged). */
    @Inject(LockService)
    private readonly locks: Pick<LockService, "lease" | "holderOf" | "releaseIf">,
    @Inject(ChannelConnections)
    private readonly connections: Pick<ChannelConnections, "row" | "send">,
    @Inject(ConversationsService)
    private readonly conversations: Pick<ConversationsService, "create" | "postUserMessage">,
    @Inject(ExternalIdentities) private readonly external: Pick<ExternalIdentities, "findAccount">,
    @Inject(IdentityBinding) private readonly binding: Pick<IdentityBinding, "createBindToken">,
    /** 通讯录同步的投递（按 (组织, 插件) 每分钟去重的维护队列任务）。 */
    @Inject(DirectorySync) private readonly directorySync: Pick<DirectorySync, "enqueue">,
    /** The channel queue: inbound jobs (`onEvent` only dedupes and enqueues) and deliveries. */
    @Inject(ChannelJobs) private readonly jobs: Pick<ChannelJobs, "enqueue" | "enqueueInbound">,
    /** 卡片操作：审批决定与提问回答（授权由这两个服务按点击者映射到的账号判定）。 */
    @Inject(ApprovalsService) approvals: Pick<ApprovalsService, "decide">,
    @Inject(QuestionsService) questions: Pick<QuestionsService, "answer">,
    @Inject(AnonymousGuests) private readonly guests: Pick<AnonymousGuests, "ensure">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "warn" | "info">,
  ) {
    this.actions = new ChannelCardActions({
      get db() {
        return kdb.db;
      },
      connections,
      approvals,
      questions,
      outbound: jobs,
      resolveSpeaker: (...args) => this.resolveSpeaker(...args),
    });
  }

  /**
   * 插件 `onEvent`：去重并入队后返回（见类注释）。返回后插件才向平台确认；抛错时插件不确认。
   */
  async onEvent(connectionId: string, e: InboundEvent): Promise<void> {
    if (e.type === "directory_changed") return this.handle(connectionId, e);
    if (e.type === "card_action") {
      if (e.eventId === undefined) {
        // 平台没给事件 id：无法识别重投，每次都处理（重复的审批 / 回答由服务回「已处理」）
        await this.jobs.enqueueInbound(connectionId, e, `inbound-${connectionId}-a${randomUUID()}`);
        return;
      }
      return this.dedupeAndEnqueue(
        connectionId,
        e,
        actionDedupeKey(connectionId, e.eventId),
        inboundJobId(connectionId, `act:${e.eventId}`),
      );
    }
    return this.dedupeAndEnqueue(
      connectionId,
      e,
      messageDedupeKey(connectionId, e.messageId),
      inboundJobId(connectionId, e.messageId),
    );
  }

  /**
   * Two-state dedupe, then enqueue (the key is `pending` while the enqueue runs, `done` after it):
   * - fresh: `SET key pending NX EX 60`, enqueue, then `SET key done EX <dedupe TTL>`; on failure the
   *   key is deleted only if still `pending` (compare-and-delete) and the error is rethrown, so the
   *   plugin does not ack and the platform redelivers;
   * - duplicate seeing `done`: already queued, return (the plugin acks);
   * - duplicate seeing `pending` (the first enqueue is still running or hangs): enqueue again with the
   *   same deterministic job id and return only once that succeeds, else throw. BullMQ `add` with an
   *   existing job id is a no-op, and completed inbound jobs are retained (1 h / 1000), so this does
   *   not create a second run; it means a redelivery is never acked before the job is really queued.
   */
  private async dedupeAndEnqueue(
    connectionId: string,
    e: InboundEvent,
    key: string,
    jobId: string,
  ): Promise<void> {
    const fresh = await this.locks.lease(key, DEDUPE_PENDING, DEDUPE_PENDING_TTL_SECONDS * 1000);
    if (!fresh) {
      const state = await this.locks.holderOf(key);
      // Ack only a known-queued event ("1" = key from the pre-two-state code during a rolling
      // upgrade); pending, or a key that vanished meanwhile (failed attempt, TTL), enqueues again
      if (state === DEDUPE_DONE || state === "1") return;
    }
    // Accepted edge: if the completed-job cap evicts the original job within the pending window,
    // the re-add below runs the event twice (a duplicate run, never a loss)
    try {
      await this.jobs.enqueueInbound(connectionId, e, jobId);
    } catch (err) {
      // a failed enqueue must not drop `done` (compare-and-delete)
      await this.locks.releaseIf(key, DEDUPE_PENDING).catch(() => {});
      throw err;
    }
    await this.redis.set(key, DEDUPE_DONE, "EX", MESSAGE_DEDUPE_TTL_SECONDS);
  }

  /** 入站任务的处理（worker 上执行；失败抛错由队列重试）。 */
  async handle(connectionId: string, e: InboundEvent): Promise<void> {
    if (e.type === "directory_changed") {
      const row = await this.connections.row(connectionId);
      if (row?.status === "active" && row.pluginEnabled) {
        await this.directorySync.enqueue(row.orgId, row.plugin);
      }
      return;
    }
    if (e.type === "card_action") {
      await this.actions.handle(connectionId, e);
      return;
    }
    await this.message(connectionId, e);
  }

  private async message(connectionId: string, e: MessageEvent): Promise<void> {
    const db = this.kdb.db;
    const connections = this.connections;
    const row = await connections.row(connectionId);
    // 连接停用、组织已删除或插件在该组织停用（停用广播与长连接断开之间仍可能有事件到达）：什么都不做
    if (row?.status !== "active" || !row.pluginEnabled) return;
    const isGroup = e.target.chatType === "group";
    if (isGroup && !e.mentionsBot) return;
    const threadKey = threadKeyOf(e.target, e.sender.externalId, e.messageId);
    // 群里回在话题里（新话题以这条消息为根）
    const replyTarget: ChannelTarget = isGroup ? { ...e.target, threadId: threadKey } : e.target;
    const { locale } = await readOrgSettings(db, row.orgId);
    // 回复带幂等键：任务重试时平台不会重复显示（一条消息至多一句回复）
    const replyKey = idempotencyKey(`${connectionId}-${e.messageId}-reply`);
    const reply = async (key: ChannelPhrase, cards?: ChannelCard[]) => {
      await connections.send(
        connectionId,
        replyTarget,
        { text: phrase(key, locale), ...(cards !== undefined && { cards }) },
        replyKey,
      );
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
        created = (await this.conversations.create(row.orgId, accountId, row.agentId)).id;
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
      const posted = await this.post(row.orgId, conversationId, accountId, {
        text: e.text,
        clientMessageId: `${connectionId}:${e.messageId}`,
      });
      seq = posted.event.seq;
      // best-effort (batch 5 review m4): a failed note must not fail the job before the thread
      // is bound for the agent's reply below
      if (posted.skillNotRun) {
        await reply("skillNotRun").catch((err: unknown) =>
          this.log.warn("cannot send the skill-not-run note", {
            connectionId,
            messageId: e.messageId,
            err,
          }),
        );
      }
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
    await this.jobs.enqueue(conversationId);
  }

  /**
   * Posts the person's message: `/name args` as a skill invocation when the kernel accepts it, else
   * as typed (phase D spec §9). A retry of the job finds the first write by `clientMessageId`
   * either way (an invocation input returns the written event before resolving the skill).
   * `skillNotRun`: the skill was found but refused with `validation_failed` (too long), so the
   * person is told it did not run (batch 4 review m2); an unknown command stays silent.
   */
  private async post(
    orgId: string,
    conversationId: string,
    accountId: string,
    input: { text: string; clientMessageId: string },
  ): Promise<{ event: ConversationEvent; skillNotRun: boolean }> {
    const cmd = parseSlashCommand(input.text.trimStart());
    let skillNotRun = false;
    if (cmd !== null) {
      try {
        const event = await this.conversations.postUserMessage(orgId, conversationId, accountId, {
          ...input,
          text: cmd.args,
          skill: { name: cmd.name },
        });
        return { event, skillNotRun };
      } catch (err) {
        if (
          !(err instanceof ApiError) ||
          (err.code !== "skill.not_invocable" && err.code !== "validation_failed")
        ) {
          throw err;
        }
        if (err.code === "validation_failed") {
          skillNotRun = true;
          this.log.info("IM skill invocation posted as text", {
            conversationId,
            skill: cmd.name,
            reason: err.message,
          });
        }
      }
    }
    const event = await this.conversations.postUserMessage(orgId, conversationId, accountId, input);
    return { event, skillNotRun };
  }

  /**
   * 第 3 步：发言人（或卡片点击者）→ 账号。按 `<插件>:<租户>` + externalId 纯查找，且须是该组织的活跃成员；
   * 否则按连接的未绑定策略回复（绑定卡片只发在私聊里）并返回 undefined。
   * `threadAccount` 为话题行记的账号（匿名访客为 null）。
   */
  async resolveSpeaker(
    connectionId: string,
    row: ChannelConnectionRow,
    sender: InboundSender,
    isGroup: boolean,
    locale: ChannelLocale,
    reply: (key: ChannelPhrase, cards?: ChannelCard[]) => Promise<void>,
  ): Promise<{ accountId: string; threadAccount: string | null } | undefined> {
    const source = `${row.plugin}:${sender.tenantId}`;
    const bound = await this.external.findAccount(source, sender.externalId);
    if (bound !== undefined && (await this.isActiveMember(row.orgId, bound))) {
      return { accountId: bound, threadAccount: bound };
    }
    // 外部租户的人（外部联系人、共享频道里的其他企业，或连接还没有租户）只能绑定，不按匿名访客处理
    const external = row.tenantId === null || sender.tenantId !== row.tenantId;
    if (row.unboundPolicy === "anonymous" && !external) {
      if (!(await this.agentVisibleToOrg(row.orgId, row.agentId))) {
        await reply("anonymousNotAllowed");
        return undefined;
      }
      return { accountId: await this.guests.ensure(row.orgId), threadAccount: null };
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
      url = await this.binding.createBindToken({
        connectionId,
        identity: {
          source,
          externalId: sender.externalId,
          tenantId: sender.tenantId,
          emailVerified: false,
          // 绑定确认页显示平台给的显示名（没有时用 externalId）
          displayName: sender.displayName?.trim() || sender.externalId,
        },
      });
    } catch (err) {
      this.log.warn("cannot create channel bind link", { connectionId, err });
      await reply("bindUnavailable");
      return undefined;
    }
    await reply("bindPrompt", [{ kind: "bind", url, text: phrase("bindPrompt", locale) }]);
    return undefined;
  }

  /** 账号是该组织成员且账号未停用。 */
  private async isActiveMember(orgId: string, accountId: string): Promise<boolean> {
    const r = await this.kdb
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
    const r = await this.kdb
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
