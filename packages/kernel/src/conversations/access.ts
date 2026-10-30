import { Inject, Injectable, Module } from "@nestjs/common";
import { type ExpressionBuilder, sql } from "kysely";
import { visibleTo } from "../agents/agent-lookup.js";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";

/**
 * A sub-agent's conversation is reached through its parent (sub-agents spec §6.1, review m6, the
 * same rule as its trajectory): the parent is a chat conversation of the same owner whose agent is
 * not deleted and still visible to the viewer. Any other kind passes. The child's own `agent_id`
 * (the dispatched agent for an org agent, §5.5) is checked on top by the callers.
 */
export const parentReachable =
  (viewerAccountId: string) => (eb: ExpressionBuilder<KernelDatabase, "conversations">) =>
    eb.or([
      eb("conversations.kind", "<>", "subagent"),
      eb.exists(
        eb
          .selectFrom("conversations as p")
          .innerJoin("agents", "agents.id", "p.agent_id")
          .select(sql`1`.as("one"))
          .whereRef("p.id", "=", "conversations.parent_conversation_id")
          .whereRef("p.org_id", "=", "conversations.org_id")
          .where("p.account_id", "=", viewerAccountId)
          .where("p.kind", "=", "chat")
          .where("agents.deleted_at", "is", null)
          .where(visibleTo(viewerAccountId)),
      ),
    ]);

/**
 * Whether a person may still see a conversation (one query, no agent view): what the event stream,
 * attachment downloads, file and output reads and the extension UI check. `ConversationsService`
 * delegates to it; it depends on the database only, so the attachments (which the skills and tools
 * use) can check access without the conversations module.
 */
@Injectable()
export class ConversationAccess {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /**
   * 轻量的可见性判定（一条查询，不加载 agent 视图），供长连接（SSE）建立时与定期复核用：
   * 会话属于该组织且归 viewer 所有、viewer 账号仍为 active、agent 未删除且对 viewer 仍可见
   * （`visibleTo` 已含「组织未删除、viewer 仍是成员」）。
   */
  async isAccessible(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom("conversations")
      .select("conversations.id")
      .where("conversations.id", "=", conversationId)
      .where("conversations.org_id", "=", orgId)
      .where("conversations.account_id", "=", viewerAccountId)
      .where("conversations.kind", "in", ["chat", "subagent"])
      .where(parentReachable(viewerAccountId))
      .where((eb) =>
        eb.and([
          eb.exists(
            eb
              .selectFrom("accounts")
              .select(sql`1`.as("one"))
              .where("accounts.id", "=", viewerAccountId)
              .where("accounts.status", "=", "active"),
          ),
          eb.exists(
            eb
              .selectFrom("agents")
              .select(sql`1`.as("one"))
              .whereRef("agents.id", "=", "conversations.agent_id")
              .where("agents.deleted_at", "is", null)
              .where(visibleTo(viewerAccountId)),
          ),
        ]),
      )
      .executeTakeFirst();
    return row !== undefined;
  }
}

/** The one {@link ConversationAccess} (database only). */
@Module({ providers: [ConversationAccess], exports: [ConversationAccess] })
export class ConversationAccessModule {}
