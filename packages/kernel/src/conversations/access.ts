import { Inject, Injectable, Module } from "@nestjs/common";
import { type Expression, type ExpressionBuilder, type SqlBool, sql } from "kysely";
import { visibleTo } from "../agents/agent-lookup.js";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";

/**
 * The root of a sub-agent conversation's tree, as a correlated scalar subquery: walks
 * `parent_conversation_id` up from the conversation's parent through sub-agent conversations of
 * the same org (at most 16 levels, far above `subagents.maxDepth`'s bound of 5) to the first
 * conversation without a parent. Null when the chain leaves the org, passes a conversation of
 * another kind or does not end.
 */
const rootOfParent = () => sql<string | null>`(
  WITH RECURSIVE up(id, parent, kind, n) AS (
    SELECT c.id, c.parent_conversation_id, c.kind, 0 FROM capybara.conversations c
    WHERE c.id = ${sql.ref("conversations.parent_conversation_id")}
      AND c.org_id = ${sql.ref("conversations.org_id")}
    UNION ALL
    SELECT c.id, c.parent_conversation_id, c.kind, up.n + 1
    FROM capybara.conversations c JOIN up ON c.id = up.parent
    WHERE up.kind = 'subagent' AND up.n < 16
      AND c.org_id = ${sql.ref("conversations.org_id")}
  )
  SELECT id FROM up WHERE parent IS NULL LIMIT 1
)`;

/**
 * A sub-agent's conversation is reached through the root of its tree (sub-agents spec §6.1,
 * review m6, the same rule as its trajectory; agent map spec §4.1: nested sub-agents at any
 * depth): the root is a chat conversation of the same org and owner whose agent is not deleted
 * and still visible to the viewer, and every conversation between is a sub-agent conversation of
 * that org. Any other kind passes. The child's own `agent_id` (the dispatched agent for an org
 * agent, §5.5) is checked on top by the callers.
 */
export const parentReachable =
  (viewerAccountId: string | Expression<string>) =>
  (eb: ExpressionBuilder<KernelDatabase, "conversations">) =>
    eb.or([
      eb("conversations.kind", "<>", "subagent"),
      eb.exists(
        eb
          .selectFrom("conversations as p")
          .innerJoin("agents", "agents.id", "p.agent_id")
          .select(sql`1`.as("one"))
          .where("p.id", "=", rootOfParent())
          .whereRef("p.org_id", "=", "conversations.org_id")
          .where("p.account_id", "=", viewerAccountId)
          .where("p.kind", "=", "chat")
          .where("p.deleted_at", "is", null)
          .where("agents.deleted_at", "is", null)
          .where(visibleTo(viewerAccountId)),
      ),
    ]);

/**
 * The predicate of {@link ConversationAccess.isAccessible} over the `conversations` table (the
 * org is the caller's condition): the conversation belongs to the viewer and is not deleted, it is
 * a chat or sub-agent conversation whose tree root is reachable ({@link parentReachable}), the
 * viewer's account is active, and its agent is not deleted and still visible to the viewer
 * (`visibleTo` includes "the org is not deleted, the viewer is still a member"). The viewer may be
 * a column of the outer query: the share liveness check (`shares/liveness.ts`) asks it of each
 * share's creator (`sql.ref("file_shares.created_by")`) in the same query.
 */
export const accessibleTo =
  (viewer: string | Expression<string>) =>
  (eb: ExpressionBuilder<KernelDatabase, "conversations">): Expression<SqlBool> =>
    eb.and([
      eb("conversations.account_id", "=", viewer),
      eb("conversations.deleted_at", "is", null),
      eb("conversations.kind", "in", ["chat", "subagent"]),
      parentReachable(viewer)(eb),
      eb.exists(
        eb
          .selectFrom("accounts")
          .select(sql`1`.as("one"))
          .where("accounts.id", "=", viewer)
          .where("accounts.status", "=", "active"),
      ),
      eb.exists(
        eb
          .selectFrom("agents")
          .select(sql`1`.as("one"))
          .whereRef("agents.id", "=", "conversations.agent_id")
          .where("agents.deleted_at", "is", null)
          .where(visibleTo(viewer)),
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
   * The light visibility check (one query, no agent view) used when a long connection (SSE) opens
   * and on its periodic re-check: {@link accessibleTo} for a conversation of this org.
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
      .where(accessibleTo(viewerAccountId))
      .executeTakeFirst();
    return row !== undefined;
  }
}

/** The one {@link ConversationAccess} (database only). */
@Module({ providers: [ConversationAccess], exports: [ConversationAccess] })
export class ConversationAccessModule {}
