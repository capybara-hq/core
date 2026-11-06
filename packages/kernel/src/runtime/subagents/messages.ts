import { Inject, Injectable, Optional } from "@nestjs/common";
import { normalizeStoredDefinition } from "../../agents/definition.js";
import { EventLog } from "../../conversations/event-log.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import { SEND_MESSAGE } from "../../tools/builtin-names.js";
import { AGENT_REFUSALS } from "../../tools/builtins/agent.js";
import { HANDBACK_NOT_A_CHILD_TEXT, HANDBACK_RESULT_TEXT } from "../../tools/builtins/handback.js";
import {
  PARENT_TARGET,
  SEND_MESSAGE_REFUSALS,
  SEND_TARGETS_LISTED,
  SENT_TO_PARENT_TEXT,
  type SendTarget,
  sentToIdleText,
  sentToRunningText,
} from "../../tools/builtins/send-message.js";
import type { ToolStepContext } from "../../tools/pipeline.js";
import { ACTIVE_RUN_STATUSES, RunJobs } from "../run-jobs.js";
import { deliveryRowOfChildRun, dispatchOfCall } from "./child.js";
import { narrowFollowUp } from "./definition.js";
import { SubagentDeliveries } from "./deliveries.js";
import {
  type ChildWriter,
  commit,
  commitDispatchIn,
  type DispatchArgs,
  type DispatchCommit,
  type DispatchDeps,
  type DispatchPlan,
  orgAgentGates,
  sentMessageIdemKey,
  taskMessage,
} from "./dispatch.js";
import { findType, resolveRoster } from "./roster.js";

/** The message tools' test seams (`SUBAGENT_MESSAGES_HOOKS`; the kernel never provides them). */
export interface SubagentMessagesHooks {
  /**
   * Called by {@link SubagentMessages.toChild} after it read whether the sub-agent has an active
   * run and before it acts on that: a test ends the run here to race the send.
   */
  afterStatusRead?(childConversationId: string): Promise<void>;
}

/** Optional provider: {@link SubagentMessagesHooks} (tests). */
export const SUBAGENT_MESSAGES_HOOKS = Symbol("SUBAGENT_MESSAGES_HOOKS");

/**
 * What a message tool call did. `logged`: its `tool_result` (and `tool.called` audit) is already
 * in the log, written with the dispatch that started an idle sub-agent; otherwise the pipeline
 * writes the result.
 */
export interface MessageOutcome {
  content: string;
  isError: boolean;
  logged?: boolean;
}

/** How often a send re-reads a sub-agent whose run started or ended while it acted. */
const SEND_ATTEMPTS = 3;

/** The sub-agent's state changed on every attempt (a run starting and ending each time). */
const SEND_RETRY_TEXT =
  "The sub-agent changed state while the message was being sent; call SendMessage again.";

const refused = (content: string): MessageOutcome => ({ content, isError: true });

/** Idempotency key of a report or note a sub-agent's call delivered to its parent. */
export const toParentIdemKey = (runId: string, callId: string): string =>
  `subagent_delivery:${runId}:${callId}`;

/**
 * Messages between the agents of one tree (agent map spec §4.2, §4.3, §5): `SendMessage` and
 * `SubagentHandback`, called by the tool pipeline.
 *
 * A message to a sub-agent ({@link toChild}) is a `user_message` in its log with
 * `dispatch.kind: "message"`, idempotent by the sending call. While the sub-agent has an active run
 * it is appended under the sub-agent's row lock, which every terminal path of its runs takes too:
 * the run absorbs it at its next model call, or, when the run ends without another call, the end's
 * `ensureRun` starts the next run from it (`RunQueue.childWakeIn`). An idle sub-agent is started
 * again through the dispatch transaction (a follow-up: it counts as a dispatch and takes a
 * concurrency slot, refused at the limits, agent map spec §6), with the gates of the sub-agent's
 * type checked again and its frozen tools narrowed to what the sender's current version allows.
 * A message never waits on a lock a running sub-agent holds while it waits for the sender's run
 * row (the dispatch transaction locks the sub-agent's row only when it has no active run).
 *
 * A sub-agent's note or report to its parent ({@link toParent}) is one `subagent_delivery` in the
 * parent's log (`SubagentDeliveries.deliverIn`), idempotent by the call.
 */
@Injectable()
export class SubagentMessages {
  /** What the dispatch transaction of a restart needs (`commit`). */
  private readonly deps: Pick<DispatchDeps, "commitDispatch" | "enqueue" | "log" | "eventLog">;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(RunJobs) jobs: RunJobs,
    @Inject(KERNEL_LOGGER) log: KernelLogger,
    @Inject(SubagentDeliveries) private readonly deliveries: SubagentDeliveries,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Optional()
    @Inject(SUBAGENT_MESSAGES_HOOKS)
    private readonly hooks?: SubagentMessagesHooks,
  ) {
    this.deps = {
      eventLog,
      enqueue: (data, jobId, kind) => jobs.enqueue(data, jobId, kind),
      log,
      commitDispatch: (a, plan, child) => this.commitDispatch(a, plan, child),
    };
  }

  /** The restart's dispatch writes in a transaction of their own (see `commitDispatchIn`). */
  @Transactional({ propagation: "requires_new" })
  private commitDispatch(
    a: DispatchArgs,
    plan: DispatchPlan,
    child: ChildWriter,
  ): Promise<DispatchCommit | null> {
    return commitDispatchIn(
      { db: this.db, eventLog: this.eventLog, config: this.config },
      a,
      plan,
      child,
    );
  }

  /** The context's handle (the transaction of a `@Transactional` method, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * `SendMessage` (agent map spec §4.2, §5.1): `to` is one of the caller's own sub-agents by id,
   * or `"parent"` in a sub-agent. Anything else (a sibling, a grandchild, another conversation's
   * sub-agent, an unknown id, `"parent"` at the root) is refused with the valid targets.
   */
  async toChild(
    ctx: ToolStepContext,
    callId: string,
    childId: string,
    text: string,
    /** The pipeline's record of why the call was allowed (the `tool.called` audit of a restart). */
    opts: { authorization?: Record<string, unknown> } = {},
  ): Promise<MessageOutcome> {
    if (childId === PARENT_TARGET && ctx.parent !== undefined) {
      return this.toParent(ctx, "note", text, callId);
    }
    const child = await this.db
      .selectFrom("conversations")
      .select(["id", "title", "subagent_type"])
      .where("id", "=", childId)
      .where("org_id", "=", ctx.orgId)
      .where("kind", "=", "subagent")
      .where("parent_conversation_id", "=", ctx.conversationId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const started = child && (await this.eventLog.findByIdem(child.id, "subagent_started"));
    if (!child || started?.type !== "subagent_started") return this.unknownTarget(ctx, childId);
    const target: SendTarget = { id: child.id, description: child.title ?? "" };
    const { template } = started.payload;
    const agentType = child.subagent_type ?? started.payload.agentType;

    // a retried call (its holder died after sending): the same answer, nothing sent twice
    const prior = await this.eventLog.findByIdem(child.id, sentMessageIdemKey(ctx.runId, callId));
    if (prior && !(await dispatchOfCall(this.db, ctx.runId, callId))) {
      return { content: sentToRunningText(target), isError: false };
    }

    // the sub-agent's type stays available to the sender (§4.1, checked at every message): an org
    // agent passes its gates, any other type is still in the sender's roster
    let current = ctx.agent;
    if (template.source === "agent") {
      const gates = await orgAgentGates(
        this.db,
        { ctx, callId },
        template.id ?? "",
        agentType,
        true,
      );
      if ("refused" in gates)
        return refused(SEND_MESSAGE_REFUSALS.notAvailable(child.id, agentType));
      current = gates.checked.definition;
    } else {
      const roster = await resolveRoster(this.db, ctx.orgId, ctx.agent);
      const entry =
        template.source === "plugin"
          ? roster.find((e) => e.source === "plugin" && e.templateId === template.id)
          : findType(roster, agentType);
      if (entry?.source !== template.source) {
        return refused(SEND_MESSAGE_REFUSALS.notAvailable(child.id, agentType));
      }
    }
    const frozen = normalizeStoredDefinition(started.payload.definition);

    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
      const active = prior === undefined && (await this.activeRunOf(child.id)) !== undefined;
      await this.hooks?.afterStatusRead?.(child.id);
      if (active) {
        const seq = await this.appendToRunning(
          ctx,
          callId,
          child.id,
          text,
          narrowFollowUp(frozen, current),
        );
        if (seq !== null) {
          await this.eventLog.notify(child.id, seq);
          return { content: sentToRunningText(target), isError: false };
        }
        continue;
      }
      const out = await this.restart(
        ctx,
        callId,
        text,
        target,
        opts.authorization,
        {
          childConversationId: child.id,
          agentType,
          source: template.source,
          agentId: template.source === "agent" ? (template.id ?? "") : ctx.agentId,
          agentVersion:
            template.source === "agent" ? (template.version ?? ctx.agentVersion) : ctx.agentVersion,
          resumed: true,
          model: started.payload.definition.model,
          tierFallback: false,
        },
        frozen,
      );
      if (out === "active") continue;
      return out;
    }
    return refused(SEND_RETRY_TEXT);
  }

  /**
   * A sub-agent's note (`SendMessage` to `"parent"`) or report (`SubagentHandback`) to its parent
   * (agent map spec §4.3, §5.2): one `subagent_delivery` of this run in the parent's log,
   * idempotent by the call; an active parent run absorbs it, an idle parent is woken.
   */
  async toParent(
    ctx: ToolStepContext,
    kind: "note" | "report",
    text: string,
    callId: string,
  ): Promise<MessageOutcome> {
    if (ctx.parent === undefined) return refused(HANDBACK_NOT_A_CHILD_TEXT);
    const row = await deliveryRowOfChildRun(this.db, ctx.runId);
    if (!row) return refused(SEND_MESSAGE_REFUSALS.notAvailableHere);
    await this.deliveries.deliverIn(
      row,
      { kind, text },
      { idemKey: toParentIdemKey(ctx.runId, callId) },
    );
    return {
      content: kind === "report" ? HANDBACK_RESULT_TEXT : SENT_TO_PARENT_TEXT,
      isError: false,
    };
  }

  /**
   * Appends the message to a sub-agent whose run is active, under its row lock (a run's terminal
   * write takes the same lock, so the run is still active when the message lands). Null when no
   * run is active any more: the caller starts one.
   */
  @Transactional({ propagation: "requires_new" })
  private async appendToRunning(
    ctx: ToolStepContext,
    callId: string,
    childId: string,
    text: string,
    narrowed: ReturnType<typeof narrowFollowUp>,
  ): Promise<number | null> {
    await this.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", childId)
      .forUpdate()
      .executeTakeFirst();
    if ((await this.activeRunOf(childId)) === undefined) return null;
    const [ev] = await this.eventLog.appendIn(childId, [
      taskMessage(ctx, callId, text, narrowed, undefined, true),
    ]);
    return ev?.seq ?? null;
  }

  /**
   * Starts an idle sub-agent again with the message (the dispatch transaction, `commit`): its row
   * is locked only after no active run was found, and again checked under the lock. `"active"`
   * when a run is active after all (the caller appends to it instead).
   */
  private async restart(
    ctx: ToolStepContext,
    callId: string,
    text: string,
    target: SendTarget,
    authorization: Record<string, unknown> | undefined,
    plan: DispatchPlan,
    frozen: ReturnType<typeof normalizeStoredDefinition>,
  ): Promise<MessageOutcome | "active"> {
    const a: DispatchArgs = {
      ctx,
      callId,
      input: { description: target.description || target.id, prompt: text },
      call: {
        toolKey: SEND_MESSAGE,
        authorization: authorization ?? { policy: "allow" },
        startedAt: Date.now(),
      },
      sent: { content: sentToIdleText(target), refusals: SEND_MESSAGE_REFUSALS },
    };
    const out = await commit(this.deps, a, plan, async (t, checked) => {
      const current = plan.source === "agent" ? checked?.definition : ctx.agent;
      if (current === undefined) throw new Error("org agent message without its checked version");
      const activeRun = () =>
        t
          .selectFrom("runs")
          .select("id")
          .where("conversation_id", "=", plan.childConversationId)
          .where("status", "in", ACTIVE_RUN_STATUSES)
          .executeTakeFirst();
      // an active sub-agent is not waited for here: its token append locks its row and then the
      // sender's run row, which this transaction already holds (review I1 of phase C)
      if (await activeRun()) return null;
      await t
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", plan.childConversationId)
        .forUpdate()
        .executeTakeFirst();
      if (await activeRun()) return null;
      const [task] = await this.eventLog.appendIn(plan.childConversationId, [
        taskMessage(ctx, callId, text, narrowFollowUp(frozen, current), undefined, true),
      ]);
      return task ?? null;
    });
    if (out === null) return "active";
    if (out.kind === "dispatched") return { content: out.content, isError: false, logged: true };
    // a gate revoked since the check above, under the dispatch's locks
    if (out.content === AGENT_REFUSALS.agentNotAvailable(plan.agentType)) {
      return refused(SEND_MESSAGE_REFUSALS.notAvailable(target.id, plan.agentType));
    }
    // a limit refusal counts the sub-agent's slot as free: when a run of it started meanwhile,
    // the message goes to that run instead
    if ((await this.activeRunOf(plan.childConversationId)) !== undefined) return "active";
    return refused(out.content);
  }

  /** The active run of a conversation, if any. */
  private activeRunOf(conversationId: string): Promise<{ id: string } | undefined> {
    return this.db
      .selectFrom("runs")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ACTIVE_RUN_STATUSES)
      .executeTakeFirst();
  }

  /** The unknown-target refusal, listing the caller's own sub-agents (newest first). */
  private async unknownTarget(ctx: ToolStepContext, to: string): Promise<MessageOutcome> {
    const rows = await this.db
      .selectFrom("conversations")
      .select(["id", "title"])
      .where("org_id", "=", ctx.orgId)
      .where("kind", "=", "subagent")
      .where("parent_conversation_id", "=", ctx.conversationId)
      .where("deleted_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(SEND_TARGETS_LISTED + 1)
      .execute();
    const listed = rows.slice(0, SEND_TARGETS_LISTED);
    let more = 0;
    if (rows.length > SEND_TARGETS_LISTED) {
      const total = await this.db
        .selectFrom("conversations")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("org_id", "=", ctx.orgId)
        .where("kind", "=", "subagent")
        .where("parent_conversation_id", "=", ctx.conversationId)
        .where("deleted_at", "is", null)
        .executeTakeFirstOrThrow();
      more = Number(total.n) - listed.length;
    }
    return refused(
      SEND_MESSAGE_REFUSALS.unknownTarget(
        to,
        listed.map((r) => ({ id: r.id, description: r.title ?? "" })),
        { hasParent: ctx.parent !== undefined, more },
      ),
    );
  }
}
