import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { KernelConfig } from "../../config/schema.js";
import type { EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent } from "../../conversations/events.js";
import type { ConversationKind, KernelDatabase, KernelDb } from "../../db/kernel-schema.js";
import { audit } from "../../identity/audit.js";
import type { ModelPurposesService } from "../../models/purposes.js";
import { AGENT_REFUSALS, type AgentToolInputT } from "../../tools/builtins/agent.js";
import type { ToolStepContext } from "../../tools/pipeline.js";
import type { ProviderRegistry } from "../providers.js";
import { ACTIVE_RUN_STATUSES, type RunJobData, runJobId } from "../run-queue.js";
import { effectiveDefinition, SubagentTypeGoneError } from "./definition.js";
import { subagentLimits } from "./limits.js";
import { SUBAGENT_PREAMBLE } from "./preamble.js";
import { findType, type RosterEntry, resolveRoster } from "./roster.js";

type KernelTrx = Transaction<KernelDatabase>;

/**
 * Refusal for an org agent in the roster (`source: "agent"`) until its gates exist (Task 12 adds
 * them and removes this text). Model-visible.
 */
export const orgAgentNotDispatchableText = (type: string): string =>
  `The agent type "${type}" runs another agent of the organization, which cannot be dispatched in this deployment; do this task yourself or use another agent type.`;

export interface DispatchDeps {
  db: KernelDb;
  eventLog: EventLog;
  purposes: Pick<ModelPurposesService, "resolve">;
  registry: Pick<ProviderRegistry, "resolve">;
  config: () => KernelConfig;
  /** Enqueues a child run (on the sub-agent run queue: `kind` is always `subagent`). */
  enqueue: (data: RunJobData, jobId: string, kind: ConversationKind) => Promise<void>;
  log: Pick<Logger, "error" | "warn">;
}

export type DispatchOutcome =
  | { kind: "dispatched"; childRunId: string }
  | { kind: "refused"; content: string };

const refused = (content: string): DispatchOutcome => ({ kind: "refused", content });

/** Idempotency key of the parent's `subagent_dispatched` event. */
export const dispatchedIdemKey = (runId: string, callId: string) =>
  `subagent_dispatched:${runId}:${callId}`;

/** What one dispatch writes, decided before its transaction. */
interface Plan {
  childConversationId: string;
  agentType: string;
  source: RosterEntry["source"];
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
 * Refusals (§4.5) start nothing: a call from a sub-agent, an unknown type, an org agent (until
 * Task 12), `resume` with `subagent_type` / `model`, a `resume` id that is not a sub-agent of this
 * conversation (whatever it is otherwise: no detail about other conversations), or one whose run
 * is still active.
 */
export async function dispatchSubagent(
  d: DispatchDeps,
  a: { ctx: ToolStepContext; callId: string; input: AgentToolInputT },
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
  const roster = await resolveRoster(d.db, ctx.orgId, ctx.agent);
  const entry = findType(roster, requested);
  if (!entry) return unknown(roster);
  if (entry.source === "agent") return refused(orgAgentNotDispatchableText(entry.type));
  let eff: Awaited<ReturnType<typeof effectiveDefinition>>;
  try {
    eff = await effectiveDefinition(d, {
      orgId: ctx.orgId,
      parent: ctx.agent,
      parentAgentId: ctx.agentId,
      entry,
      ...(input.model !== undefined && { tier: input.model }),
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
  const plan: Plan = {
    childConversationId: childId,
    agentType: entry.type,
    source: entry.source,
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
        agent_id: ctx.agentId,
        account_id: parentConv.account_id,
        title: input.description,
        kind: "subagent",
        parent_conversation_id: ctx.conversationId,
        subagent_type: entry.type,
      })
      .execute();
    const [, task] = await d.eventLog.append(
      childId,
      [
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
            template: eff.template,
            definition: eff.definition,
            preamble: SUBAGENT_PREAMBLE,
            maxSteps: eff.maxSteps,
            ...(eff.warnings.length > 0 && { warnings: eff.warnings }),
          },
        },
        taskMessage(ctx, a.callId, input.prompt),
      ],
      t,
    );
    return task as ConversationEvent;
  });
  // a new sub-agent's writer never refuses
  return out ?? refused(AGENT_REFUSALS.notAvailableHere);
}

/** A follow-up to an existing sub-agent of this conversation (§4.2 `resume`). */
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
  if (started.payload.template.source === "agent") {
    return refused(orgAgentNotDispatchableText(started.payload.agentType));
  }
  const plan: Plan = {
    childConversationId: child.id,
    agentType: child.subagent_type ?? started.payload.agentType,
    source: started.payload.template.source,
    resumed: true,
    model: started.payload.definition.model,
    tierFallback: false,
  };
  return commit(d, a, plan, async (t) => {
    // the child's row lock serializes follow-ups to one sub-agent (two in one response, or two
    // parents' runs racing): the second sees the first's run active
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", child.id)
      .forUpdate()
      .executeTakeFirst();
    const active = await t
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", child.id)
      .where("status", "in", ACTIVE_RUN_STATUSES)
      .executeTakeFirst();
    if (active) return null;
    const [task] = await d.eventLog.append(
      child.id,
      [taskMessage(ctx, a.callId, a.input.prompt)],
      t,
    );
    return task as ConversationEvent;
  }).then((r) => r ?? refused(AGENT_REFUSALS.stillRunning(a.id)));
}

const taskMessage = (ctx: ToolStepContext, callId: string, prompt: string) => ({
  type: "user_message" as const,
  payload: {
    content: [{ type: "text" as const, text: prompt }],
    authorAccountId: ctx.accountId,
    dispatch: { parentConversationId: ctx.conversationId, parentRunId: ctx.runId, callId },
  },
});

/**
 * The dispatch transaction shared by new sub-agents and follow-ups: locks the parent run row,
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
async function commit(
  d: DispatchDeps,
  a: { ctx: ToolStepContext; callId: string; input: AgentToolInputT },
  plan: Plan,
  child: (t: KernelTrx) => Promise<ConversationEvent | null>,
): Promise<DispatchOutcome | null> {
  const { ctx, callId, input } = a;
  const childRunId = randomUUID();
  const out = await d.db.transaction().execute(async (t) => {
    const parent = await t
      .selectFrom("runs")
      .select(["status", "subagent_tokens_used"])
      .where("id", "=", ctx.runId)
      .forUpdate()
      .executeTakeFirst();
    const existing = await t
      .selectFrom("subagent_dispatches")
      .select("child_run_id")
      .where("parent_run_id", "=", ctx.runId)
      .where("parent_call_id", "=", callId)
      .executeTakeFirst();
    if (existing) return { kind: "existing" as const, childRunId: existing.child_run_id };
    if (parent?.status !== "running") return { kind: "stopped" as const };
    const limit = await limitRefusal(t, d, ctx, parent.subagent_tokens_used);
    if (limit !== null) return { kind: "limit" as const, content: limit };
    const task = await child(t);
    if (task === null) return null;
    await t
      .insertInto("runs")
      .values({
        id: childRunId,
        conversation_id: plan.childConversationId,
        status: "queued",
        agent_version: ctx.agentVersion,
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
    const [dispatched] = await d.eventLog.append(
      ctx.conversationId,
      [
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
          },
        },
      ],
      t,
    );
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
        resumed: plan.resumed,
        childRunId,
      },
    });
    return {
      kind: "written" as const,
      childSeq: task.seq,
      parentSeq: (dispatched as ConversationEvent).seq,
    };
  });
  if (out === null) return null;
  // the first dispatch of this call enqueued its child (or the wait sweep re-enqueues it)
  if (out.kind === "existing") return { kind: "dispatched", childRunId: out.childRunId };
  // the result is never read: the run is over
  if (out.kind === "stopped") return refused(AGENT_REFUSALS.notAvailableHere);
  if (out.kind === "limit") return refused(out.content);
  await d.eventLog.notify(plan.childConversationId, out.childSeq);
  await d.eventLog.notify(ctx.conversationId, out.parentSeq);
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
  t: KernelTrx,
  d: DispatchDeps,
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
