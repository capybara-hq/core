import type { AppendEvent, EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../conversations/events.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { usageTokens } from "../../evals/budget.js";
import { agentResultText, type SubagentStatus } from "../../tools/builtins/agent.js";

/** Idempotency key of the parent's `subagent_finished` event. */
export const finishedIdemKey = (childRunId: string) => `subagent_finished:${childRunId}`;

/** A dispatch row, by its child run. */
export interface DispatchRow {
  parentRunId: string;
  parentCallId: string;
  parentConversationId: string;
  childConversationId: string;
  childRunId: string;
}

const DISPATCH_COLUMNS = [
  "parent_run_id",
  "parent_call_id",
  "parent_conversation_id",
  "child_conversation_id",
  "child_run_id",
] as const;

const toRow = (r: {
  parent_run_id: string;
  parent_call_id: string;
  parent_conversation_id: string;
  child_conversation_id: string;
  child_run_id: string;
}): DispatchRow => ({
  parentRunId: r.parent_run_id,
  parentCallId: r.parent_call_id,
  parentConversationId: r.parent_conversation_id,
  childConversationId: r.child_conversation_id,
  childRunId: r.child_run_id,
});

/** The dispatch that started `childRunId`, or null (not a sub-agent run). */
export async function dispatchOfChildRun(
  db: KernelSchemaDb,
  childRunId: string,
): Promise<DispatchRow | null> {
  const r = await db
    .selectFrom("subagent_dispatches")
    .select(DISPATCH_COLUMNS)
    .where("child_run_id", "=", childRunId)
    .executeTakeFirst();
  return r ? toRow(r) : null;
}

/** The dispatch of the parent call `(runId, callId)`, or null (not dispatched yet). */
export async function dispatchOfCall(
  db: KernelSchemaDb,
  runId: string,
  callId: string,
): Promise<DispatchRow | null> {
  const r = await db
    .selectFrom("subagent_dispatches")
    .select(DISPATCH_COLUMNS)
    .where("parent_run_id", "=", runId)
    .where("parent_call_id", "=", callId)
    .executeTakeFirst();
  return r ? toRow(r) : null;
}

/** All events of one run of a conversation, by seq. */
async function runEvents(
  eventLog: EventLog,
  conversationId: string,
  runId: string,
): Promise<ConversationEvent[]> {
  const out: ConversationEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await eventLog.readRunsAfter(conversationId, [runId], after, 500);
    out.push(...page);
    const last = page.at(-1);
    if (page.length < 500 || !last) return out;
    after = last.seq;
  }
}

/**
 * The tool result of a finished child run (spec §4.4) and its `subagent_finished` payload, from
 * the child's log only: the status from its terminal event, the reply from its last
 * `assistant_message` (text blocks), the tool call count from its `tool_result` events, the usage
 * from its `usage` events (compaction included) and the duration from `run_started` to the
 * terminal event. Null while the run has no terminal event.
 *
 * `modelGiven`: the parent's call named a `model`; for an org agent, which runs on its own model
 * (§5.4, §5.5), the status line then says `model: the agent's own`.
 */
export async function childResult(
  eventLog: EventLog,
  row: DispatchRow,
  /** `forSkill`: a fork invocation's report (no resume hint, see `agentResultText`). */
  opts: { modelGiven?: boolean; forSkill?: boolean } = {},
): Promise<{
  content: string;
  isError: boolean;
  finished: EventPayload<"subagent_finished">;
} | null> {
  const events = await runEvents(eventLog, row.childConversationId, row.childRunId);
  const terminal = events.find(
    (e) => e.type === "run_finished" || e.type === "run_failed" || e.type === "run_aborted",
  );
  if (!terminal) return null;
  let status: SubagentStatus;
  let errorCode: string | undefined;
  let errorMessage: string | undefined;
  let abortedBy: "user" | "parent" | undefined;
  if (terminal.type === "run_finished") status = terminal.payload.reason;
  else if (terminal.type === "run_failed") {
    status = "failed";
    errorCode = terminal.payload.error.code;
    errorMessage = terminal.payload.error.message;
  } else if (terminal.payload.detail === "wait_timeout") {
    // stopped by its parent's sub-agents wait timeout (§7.2), while the parent goes on
    status = "timed_out";
  } else {
    status = "aborted";
    // §4.4: a person's stop names its account; a stop by nobody (null) is the kernel stopping the
    // child on its parent's behalf (stopChildren with no account: the parent's end, the sweep)
    abortedBy =
      terminal.payload.reason === "user" && terminal.payload.byAccountId === null
        ? "parent"
        : "user";
  }
  const last = events.findLast((e) => e.type === "assistant_message");
  const reply =
    last?.type === "assistant_message"
      ? last.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
      : "";
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const e of events) {
    if (e.type !== "usage") continue;
    usage.inputTokens += e.payload.inputTokens;
    usage.outputTokens += e.payload.outputTokens;
    usage.cacheReadTokens += e.payload.cacheReadTokens;
    usage.cacheWriteTokens += e.payload.cacheWriteTokens;
  }
  const toolCalls = events.filter((e) => e.type === "tool_result").length;
  const startedAt = events.find((e) => e.type === "run_started")?.createdAt ?? terminal.createdAt;
  const durationMs = Math.max(0, terminal.createdAt.getTime() - startedAt.getTime());
  let ownModel = false;
  if (opts.modelGiven === true) {
    const started = await eventLog.findByIdem(row.childConversationId, "subagent_started");
    ownModel = started?.type === "subagent_started" && started.payload.template.source === "agent";
  }
  const text = agentResultText({
    reply,
    agentId: row.childConversationId,
    status,
    ...(errorCode !== undefined && { errorCode }),
    ...(errorMessage !== undefined && { errorMessage }),
    toolCalls,
    durationMs,
    tokens: usageTokens(usage),
    ...(abortedBy !== undefined && { abortedBy }),
    ...(ownModel && { ownModel }),
    ...(opts.forSkill === true && { noResumeHint: true }),
  });
  return {
    ...text,
    finished: {
      subagentId: row.childConversationId,
      childRunId: row.childRunId,
      callId: row.parentCallId,
      status,
      ...(errorCode !== undefined && { errorCode }),
      toolCalls,
      durationMs,
      usage,
    },
  };
}

/** The parent's `subagent_finished` event for a finished child (idempotent by its key). */
export const finishedEvent = (
  row: DispatchRow,
  finished: EventPayload<"subagent_finished">,
): AppendEvent => ({
  type: "subagent_finished",
  runId: row.parentRunId,
  idemKey: finishedIdemKey(row.childRunId),
  payload: finished,
});
