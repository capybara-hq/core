import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { conversationTree } from "./tree.js";

/** Values shorter than this are never matched: a short value would match ordinary text. */
export const LEAK_CHECK_MIN_LENGTH = 8;

/**
 * Whether a value a person is about to seal (an approval card's secret field) already appeared in
 * the conversation. The event payloads are searched in PG (`strpos` over the payload's JSON text,
 * for the root conversation and every sub-agent below it, every event type), so the value is a
 * bind parameter and never leaves the database; it is never logged.
 */
@Injectable()
export class ConversationLeakCheck {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /**
   * The keys of `values` (value paths) whose value, 8 characters or more, appears in the event
   * log of `conversationId`'s root conversation tree. Runs inside the caller's transaction when
   * there is one.
   */
  async leaked(
    conversationId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<string[]> {
    const candidates = Object.entries(values).filter(([, v]) => v.length >= LEAK_CHECK_MIN_LENGTH);
    if (candidates.length === 0) return [];
    const root = await rootConversationOf(this.db.db, conversationId);
    const ids = (await conversationTree(this.db.db, root)).map((c) => c.id);
    const found: string[] = [];
    for (const [path, value] of candidates) {
      // the payload is stored as JSON text, so a value is searched in its JSON-escaped form
      const needle = JSON.stringify(value).slice(1, -1);
      const r = await sql<{ hit: boolean }>`
        SELECT EXISTS (
          SELECT 1 FROM capybara.conversation_events
          WHERE conversation_id = ANY(${ids}::text[]) AND strpos(payload::text, ${needle}) > 0
        ) AS hit`.execute(this.db.db);
      if (r.rows[0]?.hit === true) found.push(path);
    }
    return found;
  }
}

/**
 * The one {@link ConversationLeakCheck} (the database only), its own module so the tools module
 * (the approval decision) imports it without importing the conversations module, which imports
 * the tools module.
 */
@Module({ providers: [ConversationLeakCheck], exports: [ConversationLeakCheck] })
export class ConversationLeakCheckModule {}
