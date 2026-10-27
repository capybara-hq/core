import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { type ConversationBusMessage, conversationTopic } from "../../conversations/event-log.js";
import type { KernelDb } from "../../db/kernel-schema.js";

/** A finished step of a sub-agent run, as the loop reports it. */
export interface SubagentStep {
  /** The parent conversation, whose topic gets the message. */
  parentConversationId: string;
  /** The child conversation (the sub-agent's id). */
  conversationId: string;
  runId: string;
  step: number;
}

export interface SubagentProgressDeps {
  db: KernelDb;
  bus: { publish(topic: string, payload: unknown): Promise<void> };
  log: Pick<Logger, "warn">;
}

/**
 * Publishes `{ kind: "subagent_progress", subagentId, step, toolCalls, lastToolKey? }` on the
 * parent conversation's topic after a child step (sub-agents spec §14.2). Ephemeral: not in any
 * log, lost on reconnect (the summary API has the current numbers). The counts come from the
 * child run's log (its `tool_result` events), never from process memory, so any replica running
 * the step reports the same. Never throws: a lost progress message costs nothing.
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
    await d.bus.publish(conversationTopic(s.parentConversationId), msg);
  } catch (err) {
    d.log.warn("sub-agent progress publish failed", {
      conversationId: s.conversationId,
      runId: s.runId,
      err,
    });
  }
}
