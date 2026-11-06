import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { EventLog } from "../../conversations/event-log.js";
import type { EventPayload } from "../../conversations/events.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { afterCommit } from "../../infra/database/after-commit.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { TransactionHost } from "../../infra/database/transaction-host.js";
import { Transactional } from "../../infra/database/transactional.decorator.js";
import { KernelEvents } from "../../infra/events/kernel-events.js";
import { KERNEL_LOGGER } from "../../infra/tokens.js";
import type { KernelLogger } from "../../log.js";
import { TERMINAL_STATUSES } from "../run-finish.js";
import { childResult, type DispatchRow, deliveryRowOfChildRun, finishedEvent } from "./child.js";
import { dispatchedIdemKey } from "./dispatch.js";

/** What a caller of {@link SubagentDeliveries.deliverIn} gives; the rest comes from the dispatch. */
export type DeliveryInput = Omit<
  EventPayload<"subagent_delivery">,
  "subagentId" | "childRunId" | "description" | "triggerAccountId"
>;

/** Idempotency key of a child run's finished delivery (one per child run). */
export const finishedDeliveryIdemKey = (childRunId: string): string =>
  `subagent_delivery:${childRunId}:finished`;

/** The longest `subagent_delivery.text` (the event schema's bound). */
const DELIVERY_TEXT_MAX = 200_000;

/**
 * Deliveries from a sub-agent to its parent conversation (agent map spec §4.5, §5.2): each is one
 * model-visible, absorbable `subagent_delivery` event in the parent's log. A parent run that is
 * active absorbs it at its next model call; an idle parent is woken from the `subagent.delivered`
 * domain event (emitted after the commit, with the log's notify).
 *
 * A background child's run reaching a terminal state ({@link childFinished}) writes the
 * display-only `subagent_finished` and a `finished` delivery in one transaction, both idempotent by
 * the child run, so of two finishers (the worker and a stop, the orphan sweep) exactly one writes
 * them. Fork invocations (phase D, `for_skill`) do not deliver: their parent run waits on the child
 * and writes the report itself (`advanceSkillForks`).
 */
@Injectable()
export class SubagentDeliveries {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(KernelEvents) private readonly events: KernelEvents,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The context's handle (the transaction of a `@Transactional` method, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * Appends one delivery of the dispatch `row` to the parent log, in the caller's transaction or
   * one of its own: the description is the dispatch's (`subagent_dispatched`), the trigger account
   * the child run's (a wake runs as that person, §7). Idempotent by `opts.idemKey` (a finish's
   * default is {@link finishedDeliveryIdemKey}; a report or a note must name its own): under the
   * parent conversation's row lock, an existing delivery returns null and writes nothing. After
   * the commit: the log's notify and `subagent.delivered`. Returns the new event's seq.
   */
  @Transactional()
  async deliverIn(
    row: DispatchRow,
    d: DeliveryInput,
    opts: { idemKey?: string } = {},
  ): Promise<number | null> {
    const idemKey =
      opts.idemKey ?? (d.kind === "finished" ? finishedDeliveryIdemKey(row.childRunId) : undefined);
    if (idemKey === undefined) throw new Error(`a ${d.kind} delivery needs its idempotency key`);
    const t = this.db;
    const parent = row.parentConversationId;
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", parent)
      .forUpdate()
      .executeTakeFirst();
    const existing = await t
      .selectFrom("conversation_events")
      .select("seq")
      .where("conversation_id", "=", parent)
      .where("idem_key", "=", idemKey)
      .executeTakeFirst();
    if (existing) return null;
    const run = await t
      .selectFrom("runs")
      .select("trigger_account_id")
      .where("id", "=", row.childRunId)
      .executeTakeFirstOrThrow();
    const [event] = await this.eventLog.appendIn(parent, [
      {
        type: "subagent_delivery",
        idemKey,
        payload: {
          subagentId: row.childConversationId,
          childRunId: row.childRunId,
          description: await this.descriptionOf(row),
          ...d,
          text: d.text.length > DELIVERY_TEXT_MAX ? d.text.slice(0, DELIVERY_TEXT_MAX) : d.text,
          triggerAccountId: run.trigger_account_id,
        },
      },
    ]);
    if (!event) return null;
    afterCommit(async () => {
      await this.eventLog.notify(parent, event.seq);
      await this.events.emit("subagent.delivered", { conversationId: parent });
    });
    return event.seq;
  }

  /**
   * A background child run reached a terminal state (agent map spec §4.5, §5.2): appends the
   * parent's `subagent_finished` (display only) and a `finished` delivery in one transaction, for
   * every run of a child conversation (dispatched, sent a message or woken;
   * {@link deliveryRowOfChildRun}), each once by its run. The delivery
   * carries the final reply when the run handed back no report, else no text and `handedBack`; a
   * failed run's error message and code, an aborted run who stopped it. A run of a conversation
   * never dispatched, a fork invocation's child, or not terminal yet is left alone. True when this
   * call wrote the delivery.
   */
  async childFinished(childRunId: string): Promise<boolean> {
    const row = await deliveryRowOfChildRun(this.db, childRunId);
    if (!row || row.forSkill === true) return false;
    const run = await this.db
      .selectFrom("runs")
      .select("status")
      .where("id", "=", childRunId)
      .executeTakeFirst();
    if (!run || !TERMINAL_STATUSES.has(run.status)) return false;
    const r = await childResult(this.eventLog, row);
    if (!r) {
      this.log.warn("sub-agent run is terminal without a terminal event", { childRunId });
      return false;
    }
    return this.finishIn(row, r);
  }

  /** {@link childFinished}'s transaction. */
  @Transactional()
  private async finishIn(
    row: DispatchRow,
    r: NonNullable<Awaited<ReturnType<typeof childResult>>>,
  ): Promise<boolean> {
    await this.eventLog.appendIn(row.parentConversationId, [finishedEvent(row, r.finished)]);
    const { status, errorCode } = r.finished;
    const handedBack = await this.handedBack(row);
    const text = handedBack
      ? ""
      : status === "failed"
        ? (r.errorMessage ?? "")
        : status === "aborted" || status === "timed_out"
          ? ""
          : r.reply;
    const seq = await this.deliverIn(row, {
      kind: "finished",
      status,
      text,
      ...(handedBack && { handedBack: true }),
      ...(errorCode !== undefined && { errorCode }),
      ...(r.abortedBy !== undefined && { abortedBy: r.abortedBy }),
    });
    return seq !== null;
  }

  /** Whether the child run handed back a report (`SubagentHandback`) before it finished. */
  private async handedBack(row: DispatchRow): Promise<boolean> {
    const hit = await this.db
      .selectFrom("conversation_events")
      .select("seq")
      .where("conversation_id", "=", row.parentConversationId)
      .where("type", "=", "subagent_delivery")
      .where(sql<string>`payload ->> 'childRunId'`, "=", row.childRunId)
      .where(sql<string>`payload ->> 'kind'`, "=", "report")
      .limit(1)
      .executeTakeFirst();
    return hit !== undefined;
  }

  /** The dispatch's task label (`subagent_dispatched.description`), else the child's title. */
  private async descriptionOf(row: DispatchRow): Promise<string> {
    const dispatched = await this.eventLog.findByIdem(
      row.parentConversationId,
      dispatchedIdemKey(row.parentRunId, row.parentCallId),
    );
    if (dispatched?.type === "subagent_dispatched") return dispatched.payload.description;
    const conv = await this.db
      .selectFrom("conversations")
      .select("title")
      .where("id", "=", row.childConversationId)
      .executeTakeFirst();
    return conv?.title ?? "";
  }
}
