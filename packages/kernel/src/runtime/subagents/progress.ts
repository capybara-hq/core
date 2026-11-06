import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { type ConversationBusMessage, conversationTopic } from "../../conversations/event-log.js";
import { conversationAncestors } from "../../conversations/tree.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";

/** A finished step of a sub-agent run, as the loop reports it. */
export interface SubagentStep {
  /** The parent conversation: its topic and those of every conversation above it get the message. */
  parentConversationId: string;
  /** The child conversation (the sub-agent's id). */
  conversationId: string;
  runId: string;
  step: number;
}

export interface SubagentProgressDeps {
  db: KernelSchemaDb;
  bus: { publish(topic: string, payload: unknown): Promise<void> };
  log: Pick<Logger, "warn">;
}

/**
 * Publishes `{ kind: "subagent_progress", subagentId, step, toolCalls, lastToolKey? }` after a
 * child step on the topic of every ancestor (sub-agents spec §14.2; agent map spec §8: the root's
 * agent map follows a sub-agent at any depth), `subagentId` naming the progressing agent.
 * Ephemeral: not in any log, lost on reconnect (the tree and summary APIs have the current
 * numbers). The counts come from the child run's log (its `tool_result` events), never from
 * process memory, so any replica running the step reports the same. Never throws: a lost progress
 * message costs nothing.
 */
export async function publishSubagentProgress(
  d: SubagentProgressDeps,
  s: SubagentStep,
): Promise<void> {
  try {
    const { rows } = await sql<{ n: string; last: string | null }>`
      SELECT count(*) AS n,
        (array_agg(e.payload->>'toolKey' ORDER BY e.seq DESC))[1] AS last
      FROM capybara.conversation_events e
      WHERE e.conversation_id = ${s.conversationId} AND e.run_id = ${s.runId}
        AND e.type = 'tool_result'
    `.execute(d.db);
    const row = rows[0];
    const msg: ConversationBusMessage = {
      kind: "subagent_progress",
      subagentId: s.conversationId,
      step: s.step,
      toolCalls: Number(row?.n ?? 0),
      ...(row?.last != null && { lastToolKey: row.last }),
    };
    const ancestors = await conversationAncestors(d.db, s.conversationId);
    const topics = new Set([s.parentConversationId, ...ancestors]);
    await Promise.all([...topics].map((id) => d.bus.publish(conversationTopic(id), msg)));
  } catch (err) {
    d.log.warn("sub-agent progress publish failed", {
      conversationId: s.conversationId,
      runId: s.runId,
      err,
    });
  }
}
