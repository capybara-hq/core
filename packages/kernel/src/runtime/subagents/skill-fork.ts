import type { Transaction } from "kysely";
import type { AppendEvent, EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../conversations/events.js";
import type { KernelDatabase } from "../../db/kernel-schema.js";
import { ApiError } from "../../errors.js";
import type { SkillInvoker } from "../../skills/invoke.js";
import { AGENT_STOPPED_WITH_RUN_TEXT } from "../../tools/builtins/agent.js";
import { subagentsWait } from "../../tools/pipeline.js";
import type { LoopContext, WaitingFor } from "../loop.js";
import { TERMINAL_STATUSES } from "../run-finish.js";
import { childResult, type DispatchRow, dispatchOfCall, finishedEvent } from "./child.js";
import { type DispatchDeps, dispatchSubagent } from "./dispatch.js";

/**
 * Forked skills (phase D spec §6): a person's invocation of a `context: fork` skill starts its own
 * run (the run boundary, {@link forkBoundary}), whose `prepare` node dispatches the sub-agent
 * through phase C's `dispatchSubagent` before any model call and waits on it like an `agent` call
 * (`subagents` wait `sa-<runId>-0`). When the child has ended, `prepare` appends the model-visible
 * `skill_fork_result` and the parent's model answers. Every terminal path of the run (and the wait
 * sweep) pairs a fork invocation without a report ({@link pairStoppedForks}), so the log never holds
 * a fork lead whose report is missing before the next model call.
 */

type KernelTrx = Transaction<KernelDatabase>;

/** The dispatch's parent call id (no `:`; there is no tool call). */
export const skillCallId = (seq: number): string => `skill-${seq}`;

/** Idempotency key of a fork invocation's report (one per invocation, whatever the run). */
export const forkResultIdemKey = (seq: number): string => `skill_fork_result:${seq}`;

/** A fork dispatch's step: before the run's first model step (steps start at 1). */
export const FORK_STEP = 0;

const SKILL_CALL_RE = /^skill-(\d+)$/;

/** The invocation seq of a fork dispatch row (`skill-<seq>` at step 0), else null. */
export const forkSeqOfCall = (callId: string, step: number): number | null => {
  const m = step === FORK_STEP ? SKILL_CALL_RE.exec(callId) : null;
  return m ? Number(m[1]) : null;
};

export type ForkInvocation = ConversationEvent & {
  type: "user_message";
  payload: EventPayload<"user_message"> & {
    skill: NonNullable<EventPayload<"user_message">["skill"]>;
  };
};

/** A person's fork invocation (`user_message.skill.mode === "fork"`). */
export const isForkInvocation = (e: ConversationEvent): e is ForkInvocation =>
  e.type === "user_message" && e.payload.skill?.mode === "fork";

/**
 * The run boundary (spec §6.3): the messages a run absorbs, in order, stopping before any fork
 * invocation other than the run's own trigger message. A fork invocation is therefore only ever
 * absorbed by the run it triggers (`RunQueue.ensureRun` makes the first unconsumed fork invocation
 * a run's trigger), at that run's first step, and is its last message there.
 */
export function forkBoundary<E extends ConversationEvent>(
  messages: readonly E[],
  triggerSeq: number,
): E[] {
  const out: E[] = [];
  for (const m of messages) {
    if (isForkInvocation(m) && m.seq !== triggerSeq) break;
    out.push(m);
  }
  return out;
}

/** The model-visible report text (spec §6.3). */
export const forkReportText = (name: string, body: string): string =>
  `Report from the sub-agent that ran the skill "${name}":\n\n${body}`;

/** The report when the run ended before the sub-agent was dispatched. */
export const FORK_NOT_STARTED_TEXT =
  "The run ended before the sub-agent started; the skill did not run.";

/** The report when the skill's instructions could not be read at dispatch. */
export const FORK_UNREADABLE_TEXT =
  "The sub-agent did not start: the skill's instructions could not be read. The user can run the skill again.";

/** What `prepare` does with the run's fork invocation. */
export type SkillForkStep =
  /** The report is in the log: go on to the model step. */
  | { kind: "ready" }
  /** The sub-agent runs: suspend on it. */
  | { kind: "suspend"; waitingFor: WaitingFor }
  /** The run is being stopped: end it; its terminal path writes the report. */
  | { kind: "aborted" }
  /**
   * End the run without a model call (full-run replay of a run whose recording has no report:
   * the original ended before it, so the replay ends there too, as a finished run with no reply).
   */
  | { kind: "end" };

/** The loop's fork handler (`LoopDeps.skillForks`): live dispatch, or the recorded report. */
export interface SkillForks {
  advance(a: { ctx: LoopContext; fork: ForkInvocation }): Promise<SkillForkStep>;
}

export interface SkillForkDeps extends DispatchDeps {
  invoker: Pick<SkillInvoker, "renderTask">;
}

const reportEvent = (
  runId: string,
  seq: number,
  text: string,
  row?: Pick<DispatchRow, "childConversationId" | "childRunId">,
): AppendEvent => ({
  type: "skill_fork_result",
  runId,
  idemKey: forkResultIdemKey(seq),
  payload: {
    invokedSeq: seq,
    ...(row !== undefined && { subagentId: row.childConversationId, childRunId: row.childRunId }),
    text,
  },
});

/**
 * In `prepare`, for the run's fork invocation: dispatch it when it has no dispatch row (rendering
 * the task from the recorded version, `SkillInvoker.renderTask`) and suspend; append the report once
 * the child has ended. Phase C's dispatch transaction applies unchanged: limits, the parent run
 * lock, the starter's credentials, the org agent gates, the stop cascade. A refusal, or a SKILL.md
 * that cannot be read, is reported as the sub-agent's result.
 */
export async function advanceSkillForks(
  d: SkillForkDeps,
  a: { ctx: LoopContext; fork: ForkInvocation },
): Promise<SkillForkStep> {
  const { ctx, fork } = a;
  const seq = fork.seq;
  const skill = fork.payload.skill;
  const ready = { kind: "ready" } as const;
  if (await d.eventLog.findByIdem(ctx.conversationId, forkResultIdemKey(seq))) return ready;
  const report = (text: string, row?: DispatchRow, extra: AppendEvent[] = []) =>
    d.eventLog.append(ctx.conversationId, [
      ...extra,
      reportEvent(ctx.runId, seq, forkReportText(skill.name, text), row),
    ]);
  const callId = skillCallId(seq);
  const row = await dispatchOfCall(d.db, ctx.runId, callId);
  if (row) {
    const r = await childResult(d.eventLog, row);
    if (!r) return ctx.signal.aborted ? { kind: "aborted" } : suspend(d, ctx);
    await report(r.content, row, [finishedEvent(row, r.finished)]);
    return ready;
  }
  if (ctx.signal.aborted) return { kind: "aborted" };
  let rendered: { task: string; warning?: string };
  try {
    rendered = await d.invoker.renderTask({
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      agent: ctx.agent,
      skill,
    });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    await report(FORK_UNREADABLE_TEXT);
    return ready;
  }
  const out = await dispatchSubagent(d, {
    ctx: {
      orgId: ctx.orgId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      step: FORK_STEP,
      agentId: ctx.agentId,
      agentVersion: ctx.agentVersion,
      agent: ctx.agent,
      accountId: ctx.triggerAccountId,
      signal: ctx.signal,
      deadline: ctx.limits.deadline,
      ...(ctx.conversationKind !== undefined &&
        ctx.conversationKind !== "eval" && { conversationKind: ctx.conversationKind }),
    },
    callId,
    input: {
      description: skill.name.slice(0, 80),
      prompt: rendered.task,
      subagent_type: skill.agentType ?? "general-purpose",
    },
    forSkill: {
      seq,
      skill,
      warnings: rendered.warning === undefined ? [] : [rendered.warning],
    },
  });
  if (out.kind === "refused") {
    // a refusal because the run is being stopped: its terminal path reports
    if (ctx.signal.aborted) return { kind: "aborted" };
    await report(out.content);
    return ready;
  }
  // a stop that arrived meanwhile never suspends on the sub-agent (phase C's rule for agent calls)
  return ctx.signal.aborted ? { kind: "aborted" } : suspend(d, ctx);
}

const suspend = (d: Pick<DispatchDeps, "config">, ctx: LoopContext): SkillForkStep => ({
  kind: "suspend",
  waitingFor: subagentsWait(ctx.runId, FORK_STEP, d.config()),
});

/** The live handler for the loop (`LoopDeps.skillForks`). */
export const liveSkillForks = (d: SkillForkDeps): SkillForks => ({
  advance: (a) => advanceSkillForks(d, a),
});

/**
 * The full-run replay's handler (spec §7, A5): never dispatches. The recorded report of the
 * original run (`skill_fork_result` with this `invokedSeq`) is appended as it was; without one (the
 * original run ended before its report) the replayed run ends there, before any model call.
 */
export const recordedSkillForks = (
  eventLog: Pick<EventLog, "append" | "findByIdem">,
  recorded: readonly { type: string; payload: unknown }[],
): SkillForks => ({
  async advance({ ctx, fork }) {
    if (await eventLog.findByIdem(ctx.conversationId, forkResultIdemKey(fork.seq))) {
      return { kind: "ready" };
    }
    const r = recorded.find(
      (e) =>
        e.type === "skill_fork_result" &&
        (e.payload as EventPayload<"skill_fork_result">).invokedSeq === fork.seq,
    );
    if (!r) return { kind: "end" };
    await eventLog.append(ctx.conversationId, [
      {
        type: "skill_fork_result",
        runId: ctx.runId,
        idemKey: forkResultIdemKey(fork.seq),
        payload: r.payload as EventPayload<"skill_fork_result">,
      },
    ]);
    return { kind: "ready" };
  },
});

/**
 * In the transaction `t` of a run's terminal path (or the wait sweep): the run's fork invocation
 * (its trigger message, by the run boundary) without a report gets one now: the ended child's
 * result (and the parent's missing `subagent_finished`), {@link AGENT_STOPPED_WITH_RUN_TEXT} for a
 * child still active (the caller stops it after its commit, as for `agent` calls), or
 * {@link FORK_NOT_STARTED_TEXT} when nothing was dispatched. Returns the call ids written
 * (`skill-<seq>`) and the highest seq; the caller notifies after its commit.
 */
export async function pairStoppedForks(
  t: KernelTrx,
  eventLog: EventLog,
  runId: string,
): Promise<{ callIds: string[]; toSeq: number | null }> {
  const none = { callIds: [], toSeq: null };
  const run = await t
    .selectFrom("runs as r")
    .innerJoin("conversations as c", "c.id", "r.conversation_id")
    .select(["r.conversation_id", "r.trigger_seq", "c.kind"])
    .where("r.id", "=", runId)
    .executeTakeFirst();
  if (run?.kind !== "chat") return none;
  const conversationId = run.conversation_id;
  const seq = Number(run.trigger_seq);
  const trigger = await t
    .selectFrom("conversation_events")
    .select(["type", "payload"])
    .where("conversation_id", "=", conversationId)
    .where("seq", "=", run.trigger_seq)
    .executeTakeFirst();
  const skill =
    trigger?.type === "user_message"
      ? (trigger.payload as EventPayload<"user_message">).skill
      : undefined;
  if (skill?.mode !== "fork") return none;
  const written = await t
    .selectFrom("conversation_events")
    .select("seq")
    .where("conversation_id", "=", conversationId)
    .where("idem_key", "=", forkResultIdemKey(seq))
    .executeTakeFirst();
  if (written) return none;
  const callId = skillCallId(seq);
  const d = await t
    .selectFrom("subagent_dispatches")
    .select([
      "parent_run_id",
      "parent_call_id",
      "parent_conversation_id",
      "child_conversation_id",
      "child_run_id",
    ])
    .where("parent_run_id", "=", runId)
    .where("parent_call_id", "=", callId)
    .executeTakeFirst();
  const events: AppendEvent[] = [];
  if (!d) {
    events.push(reportEvent(runId, seq, forkReportText(skill.name, FORK_NOT_STARTED_TEXT)));
  } else {
    const row: DispatchRow = {
      parentRunId: d.parent_run_id,
      parentCallId: d.parent_call_id,
      parentConversationId: d.parent_conversation_id,
      childConversationId: d.child_conversation_id,
      childRunId: d.child_run_id,
    };
    const child = await t
      .selectFrom("runs")
      .select("status")
      .where("id", "=", row.childRunId)
      .executeTakeFirst();
    // a child that already ended keeps its own result (its log is committed)
    const ended =
      child !== undefined && TERMINAL_STATUSES.has(child.status)
        ? await childResult(eventLog, row)
        : null;
    if (ended) events.push(finishedEvent(row, ended.finished));
    events.push(
      reportEvent(
        runId,
        seq,
        forkReportText(skill.name, ended ? ended.content : AGENT_STOPPED_WITH_RUN_TEXT),
        row,
      ),
    );
  }
  const out = await eventLog.append(conversationId, events, t);
  return { callIds: [callId], toSeq: Math.max(...out.map((e) => e.seq)) };
}
