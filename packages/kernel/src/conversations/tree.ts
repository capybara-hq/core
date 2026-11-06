import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * How many levels below a conversation the tree reads walk at most: far above
 * `subagents.maxDepth`'s bound of 5, so a corrupt parent chain cannot loop forever.
 */
const TREE_MAX_LEVELS = 16;

/**
 * A conversation and every sub-agent conversation below it (agent map spec §6: its children,
 * grandchildren and so on, through `conversations.parent_conversation_id`), each with its level
 * below `conversationId` (0 for the conversation itself), shallowest first. Deleted conversations
 * are included (a deleted root's tree is still stopped); an unknown id yields nothing.
 */
export async function conversationTree(
  db: KernelSchemaDb,
  conversationId: string,
): Promise<{ id: string; level: number }[]> {
  const r = await sql<{ id: string; level: number }>`
    WITH RECURSIVE tree(id, level) AS (
      SELECT c.id, 0 FROM capybara.conversations c WHERE c.id = ${conversationId}
      UNION ALL
      SELECT c.id, t.level + 1
      FROM capybara.conversations c JOIN tree t ON c.parent_conversation_id = t.id
      WHERE c.kind = 'subagent' AND t.level < ${TREE_MAX_LEVELS}
    )
    SELECT id, level FROM tree ORDER BY level, id`.execute(db);
  return r.rows;
}

/**
 * The ancestors of a conversation (agent map spec §8: live progress reaches every level above a
 * sub-agent), nearest first: its parent, the parent's parent and so on up to the root, through
 * `conversations.parent_conversation_id`. Empty for a root or an unknown id.
 */
export async function conversationAncestors(
  db: KernelSchemaDb,
  conversationId: string,
): Promise<string[]> {
  const r = await sql<{ id: string }>`
    WITH RECURSIVE up(id, parent, level) AS (
      SELECT c.id, c.parent_conversation_id, 0 FROM capybara.conversations c
      WHERE c.id = ${conversationId}
      UNION ALL
      SELECT c.id, c.parent_conversation_id, up.level + 1
      FROM capybara.conversations c JOIN up ON c.id = up.parent
      WHERE up.level < ${TREE_MAX_LEVELS}
    )
    SELECT id FROM up WHERE level > 0 ORDER BY level`.execute(db);
  return r.rows.map((row) => row.id);
}
