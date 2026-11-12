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

/**
 * Locks the conversations `ids` and every ancestor of theirs (`FOR NO KEY UPDATE`, in the caller's
 * transaction) tree by tree, root first: the trees in root id order, within a tree by level below
 * the root, then id. A reply locks its root conversation and only then the sub-agents' below it
 * (`ConversationsService.skipWaitsIn`), and a dispatch locks a parent before its child; a locker
 * of conversations in plain id order could take a child before its root and wait for the root
 * while such a path holds the root and waits for the child (40P01). Returns the ids locked (the
 * requested ones and their ancestors); an unknown id is skipped.
 */
export async function lockConversationTrees(
  db: KernelSchemaDb,
  ids: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const r = await sql<{ id: string }>`
    WITH RECURSIVE up(start, id, parent, level) AS (
      SELECT c.id, c.id, c.parent_conversation_id, 0 FROM capybara.conversations c
      WHERE c.id = ANY(${wanted}::text[])
      UNION ALL
      SELECT up.start, c.id, c.parent_conversation_id, up.level + 1
      FROM capybara.conversations c JOIN up ON c.id = up.parent
      WHERE up.level < ${TREE_MAX_LEVELS}
    ),
    tops AS (
      SELECT DISTINCT ON (start) start, id AS root, level AS height
      FROM up ORDER BY start, level DESC
    ),
    nodes AS (
      SELECT DISTINCT up.id, tops.root, tops.height - up.level AS depth
      FROM up JOIN tops ON tops.start = up.start
    )
    SELECT c.id FROM capybara.conversations c JOIN nodes n ON n.id = c.id
    ORDER BY n.root, n.depth, n.id
    FOR NO KEY UPDATE OF c`.execute(db);
  return r.rows.map((row) => row.id);
}
