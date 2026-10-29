import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { type AgentDefinition, normalizeStoredDefinition } from "../../agents/definition.js";
import type { EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../conversations/events.js";
import type { ConversationKind, KernelSchemaDb } from "../../db/kernel-schema.js";
import { audit } from "../../identity/audit.js";
import type { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import type { ModelPurposesService } from "../../models/purposes.js";
import { forkAgentUnknownText } from "../../skills/invoke.js";
import { AGENT_REFUSALS, type AgentToolInputT } from "../../tools/builtins/agent.js";
import type { ToolStepContext } from "../../tools/pipeline.js";
import type { ProviderRegistry } from "../providers.js";
import { ACTIVE_RUN_STATUSES, type RunJobData, runJobId } from "../run-jobs.js";
import {
  type CheckedOrgAgent,
  effectiveDefinition,
  type FollowUpNarrowing,
  narrowFollowUp,
  SubagentTypeGoneError,
} from "./definition.js";
import { subagentLimits } from "./limits.js";
import { auditRefusal, checkOrgAgent, currentAgentDefinition } from "./org-agents.js";
import { SUBAGENT_PREAMBLE } from "./preamble.js";
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
}

/**
 * Writes the child's events in the dispatch's transaction (`db` is its handle); `checked` is the
 * org agent version the in-lock gates passed. Null refuses.
 */
export type ChildWriter = (
  db: KernelSchemaDb,
  checked?: CheckedOrgAgent,
) => Promise<ConversationEvent | null>;

export type DispatchOutcome =
  | { kind: "dispatched"; childRunId: string }
  | { kind: "refused"; content: string };

const refused = (content: string): DispatchOutcome => ({ kind: "refused", content });

/**
 * A dispatch for a person's fork invocation (phase D spec §6.2, `advanceSkillForks`), not for a
 * model's `agent` call: `general-purpose` is always available (the `agent` tool and
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
 * Dispatches the sub-agent of one `agent` call (spec §7.1), after the pipeline's validation,
 * policy, approval and `tool.preExecute` stages. A new sub-agent: resolves its type and effective
 * definition, then in one transaction (holding the parent run's row lock, so the dispatches of one
 * run serialize) inserts the child conversation, appends `subagent_started` and the task message,
 * inserts the child run (`queued`) and the `subagent_dispatches` row, appends `subagent_dispatched`
 * to the parent and audits `subagent.dispatched`. A `resume` appends the follow-up message and
 * starts the child's next run the same way. After commit the child run is enqueued; a failed
 * enqueue only logs (the dispatch is durable, the wait sweep re-enqueues it).
 *
 * Refusals (§4.5) start nothing: a call from a sub-agent, an unknown type, an org agent that fails
 * one of its gates ({@link orgAgentGates}, at every dispatch and follow-up; audited
 * `subagent.refused`), `resume` with `subagent_type` / `model`, a `resume` id that is not a
 * sub-agent of this conversation (whatever it is otherwise: no detail about other conversations),
 * or one whose run is still active.
 */
export async function dispatchSubagent(
  d: DispatchDeps,
  a: {
    ctx: ToolStepContext;
    callId: string;
    input: AgentToolInputT;
    /** Phase D: a person's fork invocation (see {@link SkillForkDispatch}). */
    forSkill?: SkillForkDispatch;
  },
): Promise<DispatchOutcome> {
  const { ctx, input } = a;
  if (ctx.parent !== undefined) return refused(AGENT_REFUSALS.notAvailableHere);
  if (input.resume !== undefined) {
    if (input.subagent_type !== undefined || input.model !== undefined) {
      return refused(AGENT_REFUSALS.resumeWithType);
    }
    return resume(d, { ...a, id: input.resume });
  }
  const requested = input.subagent_type ?? "general-purpose";
  const unknown = (types: RosterEntry[]) =>
    refused(
      AGENT_REFUSALS.unknownType(
        requested,
        types.map((e) => e.type),
      ),
    );
  const fork = a.forSkill;
  const listed = await resolveRoster(d.db, ctx.orgId, ctx.agent);
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
      ...(input.model !== undefined && { tier: input.model }),
      ...(orgAgent !== undefined && { orgAgent }),
    });
  } catch (e) {
    // the template went away since the roster was read (spec §13: refuse, never fail the run)
    // the template went away since the roster was read (spec §13: refuse, never fail the run);
    // the list offered instead is read again, without it
    if (e instanceof SubagentTypeGoneError) {
      return unknown(await resolveRoster(d.db, ctx.orgId, ctx.agent));
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
          preamble: SUBAGENT_PREAMBLE,
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
 * A follow-up to an existing sub-agent of this conversation (§4.2 `resume`). It keeps the frozen
 * definition's instructions and model (replay), but is checked against what the parent may use
 * now (final review I1): a `general` / inline / plugin child's type must still be in the roster
 * of the dispatching run's version (a plugin template by its template id), else the call is
 * refused as an unknown type; an org agent child passes its gates. Its tools and org skills are
 * intersected with the current version ({@link narrowFollowUp}: the dispatching run's version,
 * or the org agent's current version as the gates read it under the lock), and the result is
 * recorded on the follow-up's task message for the run and for replay.
 */
async function resume(
  d: DispatchDeps,
  a: { ctx: ToolStepContext; callId: string; input: AgentToolInputT; id: string },
): Promise<DispatchOutcome> {
  const { ctx } = a;
  const child = await d.db
    .selectFrom("conversations")
    .select(["id", "subagent_type"])
    .where("id", "=", a.id)
    .where("org_id", "=", ctx.orgId)
    .where("kind", "=", "subagent")
    .where("parent_conversation_id", "=", ctx.conversationId)
    .executeTakeFirst();
  if (!child) return refused(AGENT_REFUSALS.noSuchAgent(a.id));
  const started = await d.eventLog.findByIdem(child.id, "subagent_started");
  if (started?.type !== "subagent_started") return refused(AGENT_REFUSALS.noSuchAgent(a.id));
  const { template } = started.payload;
  const agentType = child.subagent_type ?? started.payload.agentType;
  // an org agent's gates hold for every follow-up too (§5.5); it keeps its frozen version
  if (template.source === "agent") {
    const gates = await orgAgentGates(d.db, a, template.id ?? "", agentType, true);
    if ("refused" in gates) return gates.refused;
  } else {
    const roster = await resolveRoster(d.db, ctx.orgId, ctx.agent);
    const entry =
      template.source === "plugin"
        ? roster.find((e) => e.source === "plugin" && e.templateId === template.id)
        : findType(roster, agentType);
    if (entry?.source !== template.source) {
      return refused(
        AGENT_REFUSALS.unknownType(
          agentType,
          roster.map((e) => e.type),
        ),
      );
    }
  }
  const frozen = normalizeStoredDefinition(started.payload.definition);
  const plan: DispatchPlan = {
    childConversationId: child.id,
    agentType,
    source: template.source,
    agentId: template.source === "agent" ? (template.id ?? "") : ctx.agentId,
    agentVersion:
      template.source === "agent" ? (template.version ?? ctx.agentVersion) : ctx.agentVersion,
    resumed: true,
    model: started.payload.definition.model,
    tierFallback: false,
  };
  return commit(d, a, plan, async (t, checked) => {
    const current = template.source === "agent" ? checked?.definition : ctx.agent;
    if (current === undefined) throw new Error("org agent follow-up without its checked version");
    const activeRun = () =>
      t
        .selectFrom("runs")
        .select("id")
        .where("conversation_id", "=", child.id)
        .where("status", "in", ACTIVE_RUN_STATUSES)
        .executeTakeFirst();
    // An active child is refused before its row is locked: a running child's token append locks
    // its conversation row and then this parent run's row, which `commit` already holds, so
    // waiting for the child's row here would be a lock-order cycle (review I1). The parent row
    // lock serializes this parent's dispatches, so an earlier follow-up's run is visible here.
    if (await activeRun()) return null;
    // the child's row lock serializes follow-ups to one sub-agent; no run holds it now, so it is
    // never held by an append waiting for the parent row
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", child.id)
      .forUpdate()
      .executeTakeFirst();
    if (await activeRun()) return null;
    const [task] = await d.eventLog.appendIn(child.id, [
      taskMessage(ctx, a.callId, a.input.prompt, narrowFollowUp(frozen, current)),
    ]);
    return task as ConversationEvent;
  }).then((r) => r ?? refused(AGENT_REFUSALS.stillRunning(a.id)));
}

/**
 * The gates of an org agent sub-agent (§5.5) for this call: the allowlist of the parent agent's
 * **current** version (R5), the agent's `dispatchable`, its visibility to the person who started
 * the parent run, and not deleted. A refusal is audited `subagent.refused` and answers with the
 * §4.5 text, which names only the roster type. Checked before the dispatch transaction (a new
 * sub-agent freezes the definition read here) and again inside it under the parent run's row lock
 * ({@link commit}), so a gate revoked in between refuses (batch 9 review M1).
 */
async function orgAgentGates(
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

const taskMessage = (
  ctx: ToolStepContext,
  callId: string,
  prompt: string,
  narrowed?: FollowUpNarrowing,
  /**
   * A fork invocation's record: the child's log then holds the invocation, so its `skill_load`
   * is offered and resolves the invoked version (phase D).
   */
  skill?: SkillForkDispatch["skill"],
) => ({
  type: "user_message" as const,
  payload: {
    content: [{ type: "text" as const, text: prompt }],
    ...(skill !== undefined && { skill }),
    authorAccountId: ctx.accountId,
    dispatch: {
      parentConversationId: ctx.conversationId,
      parentRunId: ctx.runId,
      callId,
      ...(narrowed !== undefined && { narrowed }),
    },
  },
});

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
 * the existing child run back and writes nothing, and a parent run that is no longer `running`
 * (stopped, orphaned) dispatches nothing. Then the run's limits (§8.2, {@link subagentLimits}),
 * read fresh: its children's token counter at or over the cap, its dispatches (follow-ups
 * included) at the cap, or as many active children as may run at once each refuse with the §4.5
 * text. The lock serializes the dispatches of one run, so the counts cannot race.
 */
/** What the dispatch transaction did. */
export type DispatchCommit =
  | {
      kind: "existing";
      childRunId: string;
      requeue: { conversationId: string; seq: number } | null;
    }
  | { kind: "stopped" }
  | { kind: "limit"; content: string }
  | { kind: "gate"; outcome: DispatchOutcome }
  | { kind: "written"; childRunId: string; childSeq: number; parentSeq: number };

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
    .select(["status", "subagent_tokens_used"])
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
    return {
      kind: "existing" as const,
      childRunId: existing.child_run_id,
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
  const limit = await limitRefusal(t, d, ctx, parent.subagent_tokens_used);
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
    })
    .execute();
  const [dispatched] = await d.eventLog.appendIn(ctx.conversationId, [
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
  return {
    kind: "written" as const,
    childRunId,
    childSeq: task.seq,
    parentSeq: (dispatched as ConversationEvent).seq,
  };
}

async function commit(
  d: DispatchDeps,
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
    return { kind: "dispatched", childRunId: out.childRunId };
  }
  // the result is never read: the run is over
  if (out.kind === "stopped") return refused(AGENT_REFUSALS.notAvailableHere);
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
  return { kind: "dispatched", childRunId };
}

/**
 * The §4.5 refusal of a dispatch the parent run's limits forbid, or null. Runs under the parent
 * run's row lock; `tokensUsed` is the counter read with that lock.
 */
async function limitRefusal(
  t: KernelSchemaDb,
  d: Pick<DispatchDeps, "config">,
  ctx: ToolStepContext,
  tokensUsed: string | number | bigint,
): Promise<string | null> {
  const limits = await subagentLimits(t, d.config, ctx.orgId);
  if (Number(tokensUsed) >= limits.maxTokensPerRun) {
    return AGENT_REFUSALS.budget(limits.maxTokensPerRun);
  }
  const counts = await t
    .selectFrom("subagent_dispatches as sd")
    .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
    .select([
      sql<string>`count(*)`.as("total"),
      sql<string>`count(*) FILTER (WHERE cr.status IN (${sql.join(ACTIVE_RUN_STATUSES)}))`.as(
        "active",
      ),
    ])
    .where("sd.parent_run_id", "=", ctx.runId)
    .executeTakeFirstOrThrow();
  if (Number(counts.total) >= limits.maxDispatchesPerRun) {
    return AGENT_REFUSALS.tooManyDispatches(limits.maxDispatchesPerRun);
  }
  if (Number(counts.active) >= limits.maxConcurrentPerRun) {
    return AGENT_REFUSALS.tooManyConcurrent(limits.maxConcurrentPerRun);
  }
  return null;
}
