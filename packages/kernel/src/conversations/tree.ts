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
