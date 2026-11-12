import type { ConversationSource } from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * Where a conversation comes from (memory plugin spec §6.2), stored on its row at creation
 * (`conversations.source`, migration 0119) and never changed. A missing conversation throws
 * rather than guessing a source (a guess could offer a group chat what only a DM may see).
 */
export async function conversationSourceOf(
  db: Pick<KernelSchemaDb, "selectFrom">,
  conversationId: string,
): Promise<ConversationSource> {
  const row = await db
    .selectFrom("conversations")
    .select("source")
    .where("id", "=", conversationId)
    .executeTakeFirst();
  if (row === undefined) throw new Error(`conversation ${conversationId} not found`);
  return row.source;
}

/** The source of a conversation created for a channel chat of `chatType`. */
export const channelSource = (chatType: "dm" | "group"): ConversationSource =>
  chatType === "dm" ? "channel_dm" : "channel_group";
