import type { Logger } from "@capybara-hq/plugin-sdk";
import type { AppendEvent, EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../conversations/events.js";
import type { KernelDb } from "../../db/kernel-schema.js";
import { usageTokens } from "../../evals/budget.js";
import { agentResultText, type SubagentStatus } from "../../tools/builtins/agent.js";
import type { RunAbort, RunAbortDetail } from "../abort.js";
import { TERMINAL_STATUSES } from "../run-finish.js";
import { ACTIVE_RUN_STATUSES, type RunQueue } from "../run-queue.js";
import type { Waits } from "../waits.js";

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
  db: KernelDb,
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
  db: KernelDb,
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
  opts: { modelGiven?: boolean } = {},
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

export interface ChildDeps {
  db: KernelDb;
  eventLog: EventLog;
  waits: Pick<Waits, "resume">;
  log: Pick<Logger, "warn">;
}

/**
 * After a child run's terminal state committed (spec §7.3): appends `subagent_finished` to the
 * parent log (idempotent; allowed while the parent waits, it is not model-visible) and tries
 * `Waits.resume(parentRunId, childRunId)`. Every finishing child tries; the conditional resume lets
 * exactly one succeed, the last to see all its siblings terminal. A run that is not a dispatched
 * child, or not terminal yet, is left alone. A crash in between is repaired by the wait sweep and
 * by the parent's tools node, which writes a missing `subagent_finished` itself.
 */
export async function onChildFinished(d: ChildDeps, childRunId: string): Promise<void> {
  const row = await dispatchOfChildRun(d.db, childRunId);
  if (!row) return;
  const run = await d.db
    .selectFrom("runs")
    .select("status")
    .where("id", "=", childRunId)
    .executeTakeFirst();
  if (!run || !TERMINAL_STATUSES.has(run.status)) return;
  const r = await childResult(d.eventLog, row);
  if (!r) {
    d.log.warn("sub-agent run is terminal without a terminal event", { childRunId });
    return;
  }
  await d.eventLog.append(row.parentConversationId, [finishedEvent(row, r.finished)]);
  await d.waits.resume(row.parentRunId, childRunId);
}

export interface StopChildrenDeps extends ChildDeps {
  waits: Pick<Waits, "resume" | "abortWaiting">;
  runQueue: Pick<RunQueue, "abortIfOrphaned">;
  abort: Pick<RunAbort, "request">;
}

/**
 * Stops the active children of a parent run (sub-agents spec §12), or only those dispatched in
 * `opts.step`: a `waiting` child through its own `abortWaiting`, a `queued` / `running` one that
 * no worker holds directly (`abortIfOrphaned`), any other through `RunAbort.request` (the
 * cross-replica broadcast plus the marker key, so a child that starts later still sees it), after
 * which a child found `waiting` is stopped through `abortWaiting` too. A child stopped here is
 * reported to the parent at once (by `abortWaiting` itself, or {@link onChildFinished} after
 * `abortIfOrphaned`); one stopped by its worker is reported by that worker. Returns the number of
 * children asked to stop.
 *
 * `byAccountId` is the person whose action stops them, or null when the kernel stops them on the
 * parent's behalf; a child stopped with null reports the §4.4 "parent's stop" text.
 */
export async function stopChildren(
  d: StopChildrenDeps,
  parentRunId: string,
  byAccountId: string | null,
  opts: { step?: number; detail?: RunAbortDetail } = {},
): Promise<number> {
  let q = d.db
    .selectFrom("subagent_dispatches as sd")
    .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
    .select(["sd.child_conversation_id", "sd.child_run_id", "cr.status"])
    .where("sd.parent_run_id", "=", parentRunId)
    .where("cr.status", "in", ACTIVE_RUN_STATUSES);
  if (opts.step !== undefined) q = q.where("sd.step", "=", opts.step);
  const children = await q.execute();
  for (const c of children) {
    const conv = c.child_conversation_id;
    const runId = c.child_run_id;
    // abortWaiting reports the stopped child to the parent itself (Waits.subagents.finished)
    if (
      c.status === "waiting" &&
      (await d.waits.abortWaiting(conv, runId, byAccountId, opts.detail))
    ) {
      continue;
    }
    if (await d.runQueue.abortIfOrphaned(conv, runId, byAccountId, opts.detail)) {
      await onChildFinished(d, runId);
      continue;
    }
    await d.abort.request(runId, byAccountId, opts.detail);
    // the suspend handshake (see Waits.suspend): a child that became `waiting` after the read
    // above may have checked the marker before it was set, so check `waiting` again after setting
    // it (review M1)
    const now = await d.db
      .selectFrom("runs")
      .select("status")
      .where("id", "=", runId)
      .executeTakeFirst();
    if (now?.status === "waiting") {
      await d.waits.abortWaiting(conv, runId, byAccountId, opts.detail);
    }
  }
  return children.length;
}
