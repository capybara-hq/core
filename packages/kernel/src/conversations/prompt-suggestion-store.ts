import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_BUS, REDIS } from "../infra/tokens.js";
import { type ConversationBusMessage, conversationTopic } from "./event-log.js";

/**
 * Prompt suggestions (spec 2026-11-19 §4): the conversation's latest suggestion is a Redis key
 * with a TTL plus a bus message on the conversation's topic, never an event in the log. One key
 * per conversation (a newer suggestion replaces an older one); the TTL is the backstop, and the
 * readers apply the freshness rule ({@link PromptSuggestionStore.isFresh}) instead of deleting the
 * key on every message. The key is the only shared state: any replica reads it.
 */

/** How long a suggestion key lives (24 h). */
export const PROMPT_SUGGESTION_TTL_SECONDS = 86_400;

/** The conversation's suggestion key. */
export const promptSuggestionKey = (conversationId: string): string =>
  `capk:prompt-suggestion:${conversationId}`;

/** The bus message kind the SSE forwards as `event: suggestion`. */
export const PROMPT_SUGGESTION_BUS_KIND = "prompt_suggestion";

/** A stored suggestion: the run it follows, that run's `run_finished` seq, the text, when. */
export interface StoredSuggestion {
  runId: string;
  /** The seq of the run's `run_finished`: a `user_message` / `run_started` after it is newer. */
  afterSeq: number;
  text: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

const parse = (raw: string | null): StoredSuggestion | null => {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (
    typeof s.runId !== "string" ||
    typeof s.afterSeq !== "number" ||
    typeof s.text !== "string" ||
    typeof s.createdAt !== "number"
  ) {
    return null;
  }
  return { runId: s.runId, afterSeq: s.afterSeq, text: s.text, createdAt: s.createdAt };
};

/** The conversation's prompt suggestion key and its freshness rule (spec §4). */
@Injectable()
export class PromptSuggestionStore {
  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "get" | "del">,
    @Inject(KERNEL_BUS) private readonly bus: Pick<ExtensionContext["bus"], "publish">,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /**
   * Writes the key (`SET … EX` {@link PROMPT_SUGGESTION_TTL_SECONDS}), then publishes
   * `{ kind: "prompt_suggestion", conversationId, runId, afterSeq, text }` on the conversation's
   * topic. Throws when Redis or the bus fails (the caller logs).
   */
  async put(conversationId: string, s: StoredSuggestion): Promise<void> {
    await this.redis.set(
      promptSuggestionKey(conversationId),
      JSON.stringify({
        runId: s.runId,
        afterSeq: s.afterSeq,
        text: s.text,
        createdAt: s.createdAt,
      }),
      "EX",
      PROMPT_SUGGESTION_TTL_SECONDS,
    );
    const msg: ConversationBusMessage = {
      kind: PROMPT_SUGGESTION_BUS_KIND,
      conversationId,
      runId: s.runId,
      afterSeq: s.afterSeq,
      text: s.text,
    };
    await this.bus.publish(conversationTopic(conversationId), msg);
  }

  /** The stored suggestion, or null (none, expired or unreadable). Not checked for freshness. */
  async get(conversationId: string): Promise<StoredSuggestion | null> {
    return parse(await this.redis.get(promptSuggestionKey(conversationId)));
  }

  /** Deletes the key (a reader found it stale). */
  async delete(conversationId: string): Promise<void> {
    await this.redis.del(promptSuggestionKey(conversationId));
  }

  /**
   * The freshness rule (spec §4), read from PG with plain queries (no lock): `runId` is the
   * conversation's latest run and it is terminal, the log has no `user_message` and no
   * `run_started` with a seq above `afterSeq`, and the conversation's message queue is empty.
   */
  async isFresh(
    conversationId: string,
    s: Pick<StoredSuggestion, "runId" | "afterSeq">,
  ): Promise<boolean> {
    const db = this.kdb.db;
    const latest = await db
      .selectFrom("runs")
      .select(["id", "status"])
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (latest?.id !== s.runId) return false;
    if (latest.status !== "completed") return false;
    const newer = await db
      .selectFrom("conversation_events")
      .select(sql`1`.as("one"))
      .where("conversation_id", "=", conversationId)
      .where("seq", ">", String(s.afterSeq))
      .where("type", "in", ["user_message", "run_started"])
      .limit(1)
      .executeTakeFirst();
    if (newer !== undefined) return false;
    const queued = await db
      .selectFrom("conversation_queue")
      .select(sql`1`.as("one"))
      .where("conversation_id", "=", conversationId)
      .limit(1)
      .executeTakeFirst();
    return queued === undefined;
  }
}
