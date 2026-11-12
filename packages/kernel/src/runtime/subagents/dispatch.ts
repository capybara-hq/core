import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { AgentDefinition } from "../../agents/definition.js";
import type { EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../conversations/events.js";
import type { ConversationKind, KernelSchemaDb } from "../../db/kernel-schema.js";
import { audit } from "../../identity/audit.js";
import type { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import type { ModelPurposesService } from "../../models/purposes.js";
import { forkAgentUnknownText } from "../../skills/invoke.js";
import { SEND_MESSAGE } from "../../tools/builtin-names.js";
import {
  AGENT_REFUSALS,
  AGENT_TOOL,
  type AgentToolInputT,
  agentStartedText,
} from "../../tools/builtins/agent.js";
import type { ToolStepContext } from "../../tools/pipeline.js";
import type { ProviderRegistry } from "../providers.js";
import { ACTIVE_RUN_STATUSES, type RunJobData, runJobId } from "../run-jobs.js";
import { childResult, type DispatchRow, finishedEvent } from "./child.js";
import {
  type CheckedOrgAgent,
  effectiveDefinition,
  type FollowUpNarrowing,
  SubagentTypeGoneError,
} from "./definition.js";
import { subagentLimits } from "./limits.js";
import { auditRefusal, checkOrgAgent, currentAgentDefinition } from "./org-agents.js";
import {
  findType,
  GENERAL_PURPOSE_DESCRIPTION,
  type RosterEntry,
  resolveRoster,
} from "./roster.js";

export interface DispatchDeps {
  /** The context's handle: inside {@link commitDispatchIn} it is the dispatch's transaction. */
  db: KernelSchemaDb;
  eventLog: EventLog;
  purposes: Pick<ModelPurposesService, "resolve">;
  registry: Pick<ProviderRegistry, "resolve">;
  config: Pick<KernelConfigService, "get">;
  /** Enqueues a child run (on the sub-agent run queue: `kind` is always `subagent`). */
  enqueue: (data: RunJobData, jobId: string, kind: ConversationKind) => Promise<void>;
  log: Pick<Logger, "error" | "warn">;
  /**
   * Runs {@link commitDispatchIn} in a transaction of its own (`SubagentsService.commitDispatch`,
   * a `@Transactional` method).
   */
  commitDispatch: (
    a: DispatchArgs,
    plan: DispatchPlan,
    child: ChildWriter,
  ) => Promise<DispatchCommit | null>;
}

/** One dispatch's call. */
export interface DispatchArgs {
  ctx: ToolStepContext;
  callId: string;
  input: AgentToolInputT;
  forSkill?: SkillForkDispatch;
  /**
   * The `Agent` call's own record (not for a fork invocation): the logged key its `tool_result`
   * keeps (the rc `agent` for a call logged before the rename), the `tool.called` audit's
   * authorization fields, and when the pipeline started it (the audit's duration).
   */
  call?: { toolKey: string; authorization: Record<string, unknown>; startedAt: number };
  /**
   * A `SendMessage` that starts an idle sub-agent again (agent map spec §5.1, §6): its call's
   * immediate result, written with the dispatch instead of `agentStartedText`, and the texts of
   * the limit refusals. `input.description` is the sub-agent's task label, `input.prompt` the
   * message.
   */
  sent?: { content: string; refusals: LimitRefusals };
}

/** The texts of the limit refusals of a dispatch (§4.5, agent map spec §6), and of a stopped run. */
export type LimitRefusals = Pick<
  typeof AGENT_REFUSALS,
  "depthLimit" | "budget" | "tooManyDispatches" | "tooManyConcurrent"
> & { notAvailableHere: string };

/**
 * Writes the child's events in the dispatch's transaction (`db` is its handle); `checked` is the
 * org agent version the in-lock gates passed. Null refuses.
 */
export type ChildWriter = (
  db: KernelSchemaDb,
  checked?: CheckedOrgAgent,
) => Promise<ConversationEvent | null>;

export type DispatchOutcome =
  | {
      kind: "dispatched";
      childRunId: string;
      childConversationId: string;
      /** The call's immediate result (`agentStartedText`). */
      content: string;
    }
  | { kind: "refused"; content: string };

const refused = (content: string): DispatchOutcome => ({ kind: "refused", content });

/**
 * A dispatch for a person's fork invocation (phase D spec §6.2, `advanceSkillForks`), not for a
 * model's `Agent` call: `general-purpose` is always available (the `Agent` tool and
 * `subagents.general` do not gate it), an unknown type falls back to it with a warning, and the
 * child records the invoked skill.
 */
export interface SkillForkDispatch {
  /** The invocation message's seq. */
  seq: number;
  /** The invocation record (`user_message.skill`), also put on the child's task message. */
  skill: NonNullable<EventPayload<"user_message">["skill"]>;
  /** Warnings decided when rendering the task (`SkillInvoker.renderTask`). */
  warnings: string[];
  /** The task for the sub-agent's effective definition (replaces `input.prompt`). */
  task: (child: AgentDefinition) => string;
}

/** The `general-purpose` roster entry (a fork invocation always has it). */
const GENERAL_ENTRY: RosterEntry = {
  type: "general-purpose",
  source: "general",
  description: GENERAL_PURPOSE_DESCRIPTION,
};

/**
 * The depth of the run behind `ctx` below the root (agent map spec §6): 0 for a root
 * conversation's run, its parent's depth plus one for a sub-agent's.
 */
export const runDepth = (ctx: Pick<ToolStepContext, "parent">): number =>
  ctx.parent === undefined ? 0 : ctx.parent.depth + 1;

/** Idempotency key of the parent's `subagent_dispatched` event. */
export const dispatchedIdemKey = (runId: string, callId: string) =>
  `subagent_dispatched:${runId}:${callId}`;

/** What one dispatch writes, decided before its transaction. */
export interface DispatchPlan {
  childConversationId: string;
  agentType: string;
  source: RosterEntry["source"];
  /**
   * The child conversation's agent and its run's `agent_version`: the parent's for
   * general-purpose and templates, the dispatched agent's frozen version for an org agent (§5.5).
   */
  agentId: string;
  agentVersion: number;
  resumed: boolean;
  model: { provider: string; model: string };
  tierFallback: boolean;
}

/**
 * Dispatches the sub-agent of one `Agent` call (spec §7.1, agent map spec §4.1), after the
 * pipeline's validation, policy, approval and `tool.preExecute` stages: resolves its type and
 * effective definition, then in one transaction (holding the parent run's row lock, so the
 * dispatches of one run serialize) inserts the child conversation, appends `subagent_started` and
 * the task message, inserts the child run (`queued`) and the `subagent_dispatches` row, appends
 * `subagent_dispatched` and the call's `tool_result` ({@link agentStartedText}: the sub-agent runs
 * in the background) to the parent and audits `subagent.dispatched` and `tool.called`. After
 * commit the child run is enqueued; a failed enqueue only logs (the dispatch is durable, the wait
 * sweep re-enqueues it). A fork invocation (`forSkill`) writes no `tool_result`: its run waits on
 * the child (`advanceSkillForks`).
 *
 * Refusals (§4.5) start nothing: a call from a run at `subagents.maxDepth` (agent map spec §4.1:
 * its definition has no `Agent`, so only a forged call or a lowered limit gets here), an unknown
 * type, or an org agent that fails one of its gates ({@link orgAgentGates}, checked at every
 * level; audited `subagent.refused`).
 */
export async function dispatchSubagent(d: DispatchDeps, a: DispatchArgs): Promise<DispatchOutcome> {
  const { ctx, input } = a;
  const { maxDepth } = await subagentLimits(d.db, d.config, ctx.orgId);
  const childDepth = runDepth(ctx) + 1;
  if (childDepth > maxDepth) return refused(AGENT_REFUSALS.depthLimit(maxDepth));
  const requested = input.subagent_type ?? "general-purpose";
  const unknown = (types: RosterEntry[]) =>
    refused(
      AGENT_REFUSALS.unknownType(
        requested,
        types.map((e) => e.type),
      ),
    );
  const fork = a.forSkill;
  const listed = await resolveRoster(d.db, ctx.orgId, ctx.agent, d.log);
  const roster =
    fork !== undefined && !listed.some((e) => e.type === GENERAL_ENTRY.type)
      ? [GENERAL_ENTRY, ...listed]
      : listed;
  const warnings = [...(fork?.warnings ?? [])];
  let entry = findType(roster, requested);
  if (!entry && fork !== undefined) {
    // the recorded type went away since the send (a template uninstalled): run as general-purpose
    warnings.push(forkAgentUnknownText(fork.skill.name, requested));
    entry = GENERAL_ENTRY;
  }
  if (!entry) return unknown(roster);
  let orgAgent: CheckedOrgAgent | undefined;
  if (entry.source === "agent") {
    const gates = await orgAgentGates(d.db, a, entry.agentId ?? "", entry.type, false);
    if ("refused" in gates) return gates.refused;
    orgAgent = gates.checked;
  }
  let eff: Awaited<ReturnType<typeof effectiveDefinition>>;
  try {
    eff = await effectiveDefinition(d, {
      orgId: ctx.orgId,
      parent: ctx.agent,
      parentAgentId: ctx.agentId,
      entry,
      childDepth,
      maxDepth,
      ...(input.model !== undefined && { tier: input.model }),
      ...(orgAgent !== undefined && { orgAgent }),
    });
  } catch (e) {
    // the template went away since the roster was read (spec §13: refuse, never fail the run)
    // the template went away since the roster was read (spec §13: refuse, never fail the run);
    // the list offered instead is read again, without it
    if (e instanceof SubagentTypeGoneError) {
      return unknown(await resolveRoster(d.db, ctx.orgId, ctx.agent, d.log));
    }
    throw e;
  }
  const childId = randomUUID();
  const plan: DispatchPlan = {
    childConversationId: childId,
    agentType: entry.type,
    source: entry.source,
    agentId: orgAgent !== undefined ? (entry.agentId ?? "") : ctx.agentId,
    agentVersion: orgAgent?.version ?? ctx.agentVersion,
    resumed: false,
    model: eff.model,
    tierFallback: eff.tierFallback,
  };
  const out = await commit(d, a, plan, async (t) => {
    const parentConv = await t
      .selectFrom("conversations")
      .select("account_id")
      .where("id", "=", ctx.conversationId)
      .executeTakeFirstOrThrow();
    await t
      .insertInto("conversations")
      .values({
        id: childId,
        org_id: ctx.orgId,
        agent_id: plan.agentId,
        account_id: parentConv.account_id,
        title: input.description,
        kind: "subagent",
        parent_conversation_id: ctx.conversationId,
        subagent_type: entry.type,
        subagent_depth: childDepth,
        source: "subagent",
      })
      .execute();
    const [, task] = await d.eventLog.appendIn(childId, [
      {
        type: "subagent_started",
        idemKey: "subagent_started",
        payload: {
          parent: {
            conversationId: ctx.conversationId,
            runId: ctx.runId,
            callId: a.callId,
            step: ctx.step,
          },
          agentType: entry.type,
          template:
            fork === undefined
              ? eff.template
              : {
                  ...eff.template,
                  invokedSkill: {
                    id: fork.skill.id,
                    version: fork.skill.version,
                    name: fork.skill.name,
                  },
                },
          definition: eff.definition,
          preamble: eff.preamble,
          maxSteps: eff.maxSteps,
          ...([...eff.warnings, ...warnings].length > 0 && {
            warnings: [...eff.warnings, ...warnings],
          }),
        },
      },
      taskMessage(
        ctx,
        a.callId,
        fork === undefined ? input.prompt : fork.task(eff.definition),
        undefined,
        fork?.skill,
      ),
    ]);
    return task as ConversationEvent;
  });
  // a new sub-agent's writer never refuses
  return out ?? refused(AGENT_REFUSALS.notAvailableHere);
}

/**
 * The gates of an org agent sub-agent (§5.5) for this call: the allowlist of the parent agent's
 * **current** version (R5), the agent's `dispatchable`, its visibility to the person who started
 * the parent run, and not deleted. A refusal is audited `subagent.refused` and answers with the
 * §4.5 text, which names only the roster type. Checked before the dispatch transaction (a new
 * sub-agent freezes the definition read here) and again inside it under the parent run's row lock
 * ({@link commit}), so a gate revoked in between refuses (batch 9 review M1).
 */
export async function orgAgentGates(
  db: KernelSchemaDb,
  a: { ctx: ToolStepContext; callId: string },
  agentId: string,
  agentType: string,
  resumed: boolean,
): Promise<{ checked: CheckedOrgAgent } | { refused: DispatchOutcome }> {
  const { ctx } = a;
  const parentDefinition = (await currentAgentDefinition(db, ctx.agentId)) ?? {};
  const check = await checkOrgAgent(db, {
    orgId: ctx.orgId,
    parentDefinition,
    agentId,
    triggerAccountId: ctx.accountId,
  });
  if (check.ok) return { checked: { version: check.version, definition: check.definition } };
  await auditRefusal(db, {
    orgId: ctx.orgId,
    triggerAccountId: ctx.accountId,
    agentId,
    gate: check.gate,
    parentConversationId: ctx.conversationId,
    parentRunId: ctx.runId,
    callId: a.callId,
    agentType,
    resumed,
  });
  return { refused: refused(AGENT_REFUSALS.agentNotAvailable(agentType)) };
}

/**
 * A sub-agent's task message, or (`message`) a `SendMessage` from its parent (agent map spec
 * §5.1: `dispatch.kind: "message"`, idempotent by the sending call, with the follow-up narrowing
 * the run it triggers uses).
 */
export const taskMessage = (
  ctx: ToolStepContext,
  callId: string,
  prompt: string,
  narrowed?: FollowUpNarrowing,
  /**
   * A fork invocation's record: the child's log then holds the invocation, so its `Skill`
   * is offered and resolves the invoked version (phase D).
   */
  skill?: SkillForkDispatch["skill"],
  message = false,
) => ({
  type: "user_message" as const,
  ...(message && { idemKey: sentMessageIdemKey(ctx.runId, callId) }),
  payload: {
    content: [{ type: "text" as const, text: prompt }],
    ...(skill !== undefined && { skill }),
    authorAccountId: ctx.accountId,
    dispatch: {
      parentConversationId: ctx.conversationId,
      parentRunId: ctx.runId,
      callId,
      ...(message && { kind: "message" as const }),
      ...(narrowed !== undefined && { narrowed }),
    },
  },
});

/** Idempotency key of a `SendMessage`'s `user_message` in the sub-agent's log. */
export const sentMessageIdemKey = (runId: string, callId: string): string =>
  `send_message:${runId}:${callId}`;

/**
 * The dispatch transaction shared by new sub-agents and follow-ups: locks the parent conversation
 * row, then the parent run row (the order every terminal path uses),
 * runs `child` (writes the child conversation's first events and returns the task message, or
 * null to refuse), then inserts the child run and the dispatch row, appends `subagent_dispatched`
 * and the audit row. After commit: notifies both conversations and enqueues the child run.
 * Returns null when `child` refused.
 *
 * Under the parent run's row lock it first re-checks what the pipeline checked without it: a call
 * already dispatched (a second holder of the same step, e.g. after a stalled-job takeover) gets
 * the existing child run back and writes nothing but a missing `Agent` result, and a parent run that is no longer `running`
 * (stopped, orphaned) dispatches nothing. Then the limits (§8.2, agent map spec §6,
 * {@link subagentLimits}), read fresh: the depth, the tree's token counter at or over the cap,
 * its dispatches (follow-ups included) at the cap, or as many active children of the parent
 * conversation as may run at once each refuse with the §4.5 text. The budget run's row lock
 * serializes the dispatches of one tree, so the counts cannot race.
 */
/** What the dispatch transaction did. */
export type DispatchCommit =
  | {
      kind: "existing";
      childRunId: string;
      childConversationId: string;
      requeue: { conversationId: string; seq: number } | null;
      /** The call's logged result (null for a fork dispatch) and its seq, to notify. */
      result: { content: string; seq: number } | null;
    }
  | { kind: "stopped" }
  | { kind: "limit"; content: string }
  | { kind: "gate"; outcome: DispatchOutcome }
  | { kind: "written"; childRunId: string; childSeq: number; parentSeq: number; content: string };

const isActiveStatus = (status: string): boolean =>
  (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);

/**
 * The result text of a child run that ended before its parent's call got a result and was never
 * delivered (agent map spec, rc upgrade: a foreground-era dispatch whose rc finisher wrote
 * `subagent_finished` and resumed the parent): the child's report (`childResult`), with the
 * parent's `subagent_finished` appended in this transaction when it is missing (idempotent by its
 * key), so the undelivered sweep never delivers it a second time. Null when the parent already
 * has a delivery for the run (it carries the result) or the run has no terminal event yet.
 */
async function rcFinishedResult(
  d: Pick<DispatchDeps, "db" | "eventLog">,
  row: DispatchRow,
): Promise<string | null> {
  const delivered = await d.db
    .selectFrom("conversation_events")
    .select("seq")
    .where("conversation_id", "=", row.parentConversationId)
    .where("type", "=", "subagent_delivery")
    .where(sql<string>`payload ->> 'childRunId'`, "=", row.childRunId)
    .limit(1)
    .executeTakeFirst();
  if (delivered) return null;
  const r = await childResult(d.eventLog, row);
  if (!r) return null;
  await d.eventLog.appendIn(row.parentConversationId, [finishedEvent(row, r.finished)]);
  return r.content;
}

/**
 * {@link commit}'s transaction (run by `SubagentsService.commitDispatch`, `d.db` its handle).
 * Null when `child` refused.
 */
export async function commitDispatchIn(
  d: Pick<DispatchDeps, "db" | "eventLog" | "config">,
  a: DispatchArgs,
  plan: DispatchPlan,
  child: ChildWriter,
): Promise<DispatchCommit | null> {
  const { ctx, callId, input } = a;
  const childRunId = randomUUID();
  const t = d.db;
  // the documented order, conversation row then run row (run-finish.ts, abortWaiting): the
  // append to the parent below takes the conversation row, so it is taken first here, or a stop
  // racing this commit could deadlock (final review m2); the child's row comes last
  await t
    .selectFrom("conversations")
    .select("id")
    .where("id", "=", ctx.conversationId)
    .forUpdate()
    .executeTakeFirst();
  const parent = await t
    .selectFrom("runs")
    .select(["status", "subagent_tokens_used", "budget_run_id", "scheduled_task_run_id"])
    .where("id", "=", ctx.runId)
    .forUpdate()
    .executeTakeFirst();
  const existing = await t
    .selectFrom("subagent_dispatches as sd")
    .leftJoin("runs as cr", "cr.id", "sd.child_run_id")
    .select(["sd.child_run_id", "sd.child_conversation_id", "cr.status", "cr.trigger_seq"])
    .where("sd.parent_run_id", "=", ctx.runId)
    .where("sd.parent_call_id", "=", callId)
    .executeTakeFirst();
  if (existing) {
    // An `Agent` call's result was written with its first dispatch (this returns it). A call
    // dispatched before `Agent` ran in the background (a foreground wait in flight across the
    // upgrade) gets the immediate result now, so the log never keeps it unpaired; such a call
    // reaches here again through the pipeline's policy stages, so it may ask for approval again.
    let result: { content: string; seq: number } | null = null;
    if (a.forSkill === undefined) {
      // an rc child that already ended under the foreground wait, whose rc finisher wrote
      // `subagent_finished` and resumed this run (no delivery; the sweep never delivers a run with
      // `subagent_finished`): its report is this call's result, as the rc gave it, or it is lost.
      // Only while the call has no result: a call that has one (a background dispatch's second
      // holder) keeps it, and its child's finish stays to its delivery or the undelivered sweep.
      const resultKey = resultEvent(ctx, callId, AGENT_TOOL, "").idemKey;
      const finished =
        a.sent === undefined &&
        existing.status !== null &&
        !isActiveStatus(existing.status) &&
        (await d.eventLog.findByIdem(ctx.conversationId, resultKey)) === undefined
          ? await rcFinishedResult(d, {
              parentRunId: ctx.runId,
              parentCallId: callId,
              parentConversationId: ctx.conversationId,
              childConversationId: existing.child_conversation_id,
              childRunId: existing.child_run_id,
            })
          : null;
      const [ev] = await d.eventLog.appendIn(ctx.conversationId, [
        resultEvent(
          ctx,
          callId,
          a.call?.toolKey ?? AGENT_TOOL,
          finished ?? a.sent?.content ?? agentStartedText(existing.child_conversation_id),
        ),
      ]);
      if (ev?.type === "tool_result") result = { content: ev.payload.content, seq: ev.seq };
    }
    return {
      kind: "existing" as const,
      childRunId: existing.child_run_id,
      childConversationId: existing.child_conversation_id,
      result,
      // still queued: the first holder may have died before its enqueue (review M4)
      requeue:
        existing.status === "queued" && existing.trigger_seq !== null
          ? {
              conversationId: existing.child_conversation_id,
              seq: Number(existing.trigger_seq),
            }
          : null,
    };
  }
  if (parent?.status !== "running") return { kind: "stopped" as const };
  // the tree's budget run (agent map spec §6), locked after the parent run so the dispatches of
  // every run of one tree serialize on it; the parent run itself when it opened the window
  const budgetRunId = parent.budget_run_id ?? ctx.runId;
  const tokensUsed =
    budgetRunId === ctx.runId
      ? parent.subagent_tokens_used
      : ((
          await t
            .selectFrom("runs")
            .select("subagent_tokens_used")
            .where("id", "=", budgetRunId)
            .forUpdate()
            .executeTakeFirst()
        )?.subagent_tokens_used ?? 0);
  const limit = await limitRefusal(
    t,
    d,
    ctx,
    budgetRunId,
    tokensUsed,
    a.sent?.refusals ?? AGENT_REFUSALS,
  );
  if (limit !== null) return { kind: "limit" as const, content: limit };
  let checked: CheckedOrgAgent | undefined;
  if (plan.source === "agent") {
    // the org agent's gates again, under the parent run's lock, with both agents' rows held
    // FOR SHARE (in id order) so a concurrent save of either serializes with this dispatch
    await t
      .selectFrom("agents")
      .select("id")
      .where("id", "in", [ctx.agentId, plan.agentId])
      .orderBy("id")
      .forShare()
      .execute();
    const gates = await orgAgentGates(t, a, plan.agentId, plan.agentType, plan.resumed);
    if ("refused" in gates) return { kind: "gate" as const, outcome: gates.refused };
    checked = gates.checked;
  }
  const task = await child(t, checked);
  if (task === null) return null;
  await t
    .insertInto("runs")
    .values({
      id: childRunId,
      conversation_id: plan.childConversationId,
      status: "queued",
      agent_version: plan.agentVersion,
      trigger_account_id: ctx.accountId,
      trigger_seq: task.seq,
      budget_run_id: budgetRunId,
      // an unattended parent's sub-agents are unattended too (scheduled tasks spec §4)
      scheduled_task_run_id: parent.scheduled_task_run_id,
    })
    .execute();
  await t
    .insertInto("subagent_dispatches")
    .values({
      parent_run_id: ctx.runId,
      parent_call_id: callId,
      parent_conversation_id: ctx.conversationId,
      step: ctx.step,
      child_conversation_id: plan.childConversationId,
      child_run_id: childRunId,
      resumed: plan.resumed,
      budget_run_id: budgetRunId,
      for_skill: a.forSkill !== undefined,
    })
    .execute();
  // an org agent runs on its own model (§5.4): a `model` on the call was ignored
  const ownModel = plan.source === "agent" && input.model !== undefined;
  const content = a.sent?.content ?? agentStartedText(plan.childConversationId, { ownModel });
  const parentEvents = await d.eventLog.appendIn(ctx.conversationId, [
    {
      type: "subagent_dispatched",
      runId: ctx.runId,
      idemKey: dispatchedIdemKey(ctx.runId, callId),
      payload: {
        step: ctx.step,
        callId,
        subagentId: plan.childConversationId,
        childRunId,
        agentType: plan.agentType,
        description: input.description,
        resumed: plan.resumed,
        model: { provider: plan.model.provider, model: plan.model.model },
        ...(plan.tierFallback && { tierFallback: true }),
        ...(a.forSkill !== undefined && { invokedSeq: a.forSkill.seq }),
      },
    },
    // an `Agent` call's result is immediate (agent map spec §4.1): the sub-agent works in the
    // background and reports through `subagent_delivery`; a fork invocation has no tool call
    ...(a.forSkill === undefined
      ? [resultEvent(ctx, callId, a.call?.toolKey ?? AGENT_TOOL, content)]
      : []),
  ]);
  await audit(t, {
    actorAccountId: ctx.accountId,
    orgId: ctx.orgId,
    action: "subagent.dispatched",
    target: plan.childConversationId,
    detail: {
      parentConversationId: ctx.conversationId,
      parentRunId: ctx.runId,
      callId,
      agentType: plan.agentType,
      source: plan.source,
      ...(plan.source === "agent" && {
        agentId: plan.agentId,
        agentVersion: plan.agentVersion,
      }),
      resumed: plan.resumed,
      childRunId,
    },
  });
  if (a.forSkill === undefined) {
    await audit(t, {
      actorAccountId: ctx.accountId,
      orgId: ctx.orgId,
      action: "tool.called",
      target: ctx.conversationId,
      detail: {
        toolKey: a.sent !== undefined ? SEND_MESSAGE : AGENT_TOOL,
        isError: false,
        durationMs: a.call === undefined ? null : Math.max(0, Date.now() - a.call.startedAt),
        agentId: ctx.agentId,
        agentVersion: ctx.agentVersion,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
        callId,
        ...a.call?.authorization,
      },
    });
  }
  return {
    kind: "written" as const,
    childRunId,
    childSeq: task.seq,
    parentSeq: Math.max(...parentEvents.map((e) => e.seq)),
    content,
  };
}

/**
 * The immediate `tool_result` of an `Agent` call ({@link agentStartedText}) or of a `SendMessage`
 * that started an idle sub-agent, idempotent by the call.
 */
const resultEvent = (ctx: ToolStepContext, callId: string, toolKey: string, content: string) => ({
  type: "tool_result" as const,
  runId: ctx.runId,
  idemKey: `tool_result:${ctx.runId}:${callId}`,
  payload: { step: ctx.step, callId, toolKey, content, isError: false },
});

export async function commit(
  d: Pick<DispatchDeps, "commitDispatch" | "enqueue" | "log" | "eventLog">,
  a: DispatchArgs,
  plan: DispatchPlan,
  /** Writes the child's events; `checked` is the org agent version the in-lock gates passed. */
  child: ChildWriter,
): Promise<DispatchOutcome | null> {
  const { ctx } = a;
  const out = await d.commitDispatch(a, plan, child);
  if (out === null) return null;
  if (out.kind === "existing") {
    // a child still queued is enqueued again under the first dispatch's job id (BullMQ dedupes
    // it while that job exists), so a holder that died before its enqueue does not leave the
    // child to the wait sweep
    if (out.requeue !== null) {
      const jobId = runJobId(out.requeue.conversationId, out.requeue.seq);
      await d
        .enqueue(
          { runId: out.childRunId, conversationId: out.requeue.conversationId },
          jobId,
          "subagent",
        )
        .catch((err: unknown) =>
          d.log.error("cannot enqueue sub-agent run; the sweep retries", {
            childRunId: out.childRunId,
            jobId,
            err,
          }),
        );
    }
    if (out.result !== null) await d.eventLog.notify(ctx.conversationId, out.result.seq);
    return {
      kind: "dispatched",
      childRunId: out.childRunId,
      childConversationId: out.childConversationId,
      content: out.result?.content ?? a.sent?.content ?? agentStartedText(out.childConversationId),
    };
  }
  // the result is never read: the run is over
  if (out.kind === "stopped") {
    return refused((a.sent?.refusals ?? AGENT_REFUSALS).notAvailableHere);
  }
  if (out.kind === "limit") return refused(out.content);
  if (out.kind === "gate") return out.outcome;
  await d.eventLog.notify(plan.childConversationId, out.childSeq);
  await d.eventLog.notify(ctx.conversationId, out.parentSeq);
  const childRunId = out.childRunId;
  const jobId = runJobId(plan.childConversationId, out.childSeq);
  try {
    await d.enqueue(
      { runId: childRunId, conversationId: plan.childConversationId },
      jobId,
      "subagent",
    );
  } catch (err) {
    // the dispatch is committed: the wait sweep re-enqueues the queued child run
    d.log.error("cannot enqueue sub-agent run; the sweep retries", { childRunId, jobId, err });
  }
  return {
    kind: "dispatched",
    childRunId,
    childConversationId: plan.childConversationId,
    content: out.content,
  };
}

/**
 * The §4.5 refusal of a dispatch the limits forbid, or null (agent map spec §6). Runs under the
 * parent conversation's, the parent run's and the budget run's row locks; `tokensUsed` is the
 * budget run's counter read with its lock. A dispatch from a run at `maxDepth` is refused (the
 * limit may have been lowered since the call's definition was frozen); tokens and dispatches
 * (follow-ups included) count the whole tree on its budget run; concurrency counts the child
 * conversations of the parent conversation that have an active run, whatever started that run.
 */
async function limitRefusal(
  t: KernelSchemaDb,
  d: Pick<DispatchDeps, "config">,
  ctx: ToolStepContext,
  budgetRunId: string,
  tokensUsed: string | number | bigint,
  texts: LimitRefusals,
): Promise<string | null> {
  const limits = await subagentLimits(t, d.config, ctx.orgId);
  if (runDepth(ctx) >= limits.maxDepth) return texts.depthLimit(limits.maxDepth);
  // 0: no limit (the deployment config or the org's override)
  if (limits.maxTokensPerRun > 0 && Number(tokensUsed) >= limits.maxTokensPerRun) {
    return texts.budget(limits.maxTokensPerRun);
  }
  if (limits.maxDispatchesPerRun > 0) {
    const total = await t
      .selectFrom("subagent_dispatches")
      .select(sql<string>`count(*)`.as("n"))
      .where("budget_run_id", "=", budgetRunId)
      .executeTakeFirstOrThrow();
    if (Number(total.n) >= limits.maxDispatchesPerRun) {
      return texts.tooManyDispatches(limits.maxDispatchesPerRun);
    }
  }
  // every child conversation with an active run of any origin: a dispatch, a message it never
  // absorbed (a continuation run) or a wake run all hold its slot
  const active = await t
    .selectFrom("conversations as c")
    .select(sql<string>`count(*)`.as("n"))
    .where("c.parent_conversation_id", "=", ctx.conversationId)
    .where("c.kind", "=", "subagent")
    .where("c.deleted_at", "is", null)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("runs as cr")
          .select(sql`1`.as("one"))
          .whereRef("cr.conversation_id", "=", "c.id")
          .where("cr.status", "in", ACTIVE_RUN_STATUSES),
      ),
    )
    .executeTakeFirstOrThrow();
  if (Number(active.n) >= limits.maxConcurrentPerConversation) {
    return texts.tooManyConcurrent(limits.maxConcurrentPerConversation);
  }
  return null;
}
