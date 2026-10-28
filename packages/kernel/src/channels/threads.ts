import { randomUUID } from "node:crypto";
import type { ChannelTarget } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";

/** 匿名访客账号的显示名。 */
const ANONYMOUS_DISPLAY_NAME = "Anonymous guest";
/** 匿名访客成员关系的来源标记（通讯录同步只撤销 `directory:*`，不会碰它）。 */
const ANONYMOUS_MEMBERSHIP_SOURCE = "anonymous";

/**
 * 该组织唯一的匿名访客账号 id；首次使用时创建（`accounts.status = active`、没有任何登录方式、组织角色 guest）。
 * 每次都确保成员关系存在（被移出后再次使用会补回 guest）：运行的兜底扫描会中止「发起人已不是该组织成员」的运行。
 * 跨副本并发首次创建用事务级咨询锁串行化，只建一个账号。
 */
export async function ensureAnonymousGuest(db: KernelSchemaDb, orgId: string): Promise<string> {
  return db.transaction().execute(async (t) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.anonymous:${orgId}`}))`.execute(t);
    const existing = await t
      .selectFrom("org_anonymous_accounts")
      .select("account_id")
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    let accountId = existing?.account_id;
    if (accountId === undefined) {
      accountId = randomUUID();
      await t
        .insertInto("accounts")
        .values({ id: accountId, display_name: ANONYMOUS_DISPLAY_NAME, email: null })
        .execute();
      await t
        .insertInto("org_anonymous_accounts")
        .values({ org_id: orgId, account_id: accountId })
        .execute();
      await audit(t, {
        orgId,
        action: "account.created",
        target: accountId,
        detail: { anonymousGuest: true },
      });
    }
    await t
      .insertInto("memberships")
      .values({
        org_id: orgId,
        account_id: accountId,
        role: "guest",
        source: ANONYMOUS_MEMBERSHIP_SOURCE,
      })
      .onConflict((oc) => oc.columns(["org_id", "account_id"]).doNothing())
      .execute();
    return accountId;
  });
}

/** 一条 IM 话题的定位：连接 + chat + 话题键 + 账号（匿名为 null）。 */
export interface ThreadKey {
  connectionId: string;
  chatId: string;
  threadKey: string;
  accountId: string | null;
}

/**
 * 话题键：私聊 `dm:<externalId>`；群聊用平台话题 id，消息不在话题里（开启新话题）时用该消息 id——
 * 机器人回复在以它为根的话题里，后续消息的 threadId 就是它，于是落到同一个对话。
 */
export function threadKeyOf(
  target: ChannelTarget,
  senderExternalId: string,
  messageId: string,
): string {
  if (target.chatType === "dm") return `dm:${senderExternalId}`;
  return target.threadId ?? messageId;
}

/** 未归档的话题行对应的会话；没有返回 undefined。 */
export async function findThread(db: KernelSchemaDb, k: ThreadKey): Promise<string | undefined> {
  const row = await db
    .selectFrom("channel_threads")
    .select("conversation_id")
    .where("connection_id", "=", k.connectionId)
    .where("chat_id", "=", k.chatId)
    .where("thread_key", "=", k.threadKey)
    .where(sql<string>`coalesce(account_id::text, '')`, "=", k.accountId ?? "")
    .where("archived_at", "is", null)
    .executeTakeFirst();
  return row?.conversation_id;
}

/**
 * 记下话题 → 会话；同一话题已有未归档的行（并发的另一条消息抢先建了）时不写，返回已有的会话 id。
 * 返回实际生效的会话 id。
 */
export async function insertThread(
  db: KernelSchemaDb,
  k: ThreadKey,
  conversationId: string,
): Promise<string> {
  const r = await sql<{ conversation_id: string }>`
    INSERT INTO capybara.channel_threads (id, connection_id, chat_id, thread_key, account_id, conversation_id)
    VALUES (${randomUUID()}, ${k.connectionId}, ${k.chatId}, ${k.threadKey}, ${k.accountId}, ${conversationId})
    ON CONFLICT (connection_id, chat_id, thread_key, coalesce(account_id::text, ''))
      WHERE archived_at IS NULL DO NOTHING
    RETURNING conversation_id`.execute(db);
  if (r.rows[0]) return r.rows[0].conversation_id;
  const winner = await findThread(db, k);
  if (winner === undefined) throw new Error("channel thread vanished after a conflicting insert");
  return winner;
}

/** 私聊 `/new`：归档当前话题行（下一条消息新建对话）。返回是否归档了一行。 */
export async function archiveThread(db: KernelSchemaDb, k: ThreadKey): Promise<boolean> {
  const r = await db
    .updateTable("channel_threads")
    .set({ archived_at: sql<Date>`now()` })
    .where("connection_id", "=", k.connectionId)
    .where("chat_id", "=", k.chatId)
    .where("thread_key", "=", k.threadKey)
    .where(sql<string>`coalesce(account_id::text, '')`, "=", k.accountId ?? "")
    .where("archived_at", "is", null)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n;
}
