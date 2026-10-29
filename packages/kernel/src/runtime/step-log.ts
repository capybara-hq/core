import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { type AppendEvent, EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import { usageTokens } from "../evals/budget.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { recordToolSpecs } from "../tools/specs.js";

/** An audit row written with the events (`identity/audit.ts`). */
export type StepAuditEntry = Parameters<typeof audit>[1];

/**
 * The writes of a run step that go to the event log together with another row, each in a
 * transaction of its own (the caller notifies the log after the commit): a model call with the
 * tool definitions it sent, a denial with its audit row, and a sub-agent's usage counted on its
 * parent run. The step functions (`model-call.ts`, `hook-calls.ts`) reach it through their deps.
 */
@Injectable()
export class StepLog {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * Appends events of a sub-agent's run and adds the tokens of the usage events it newly wrote to
   * the parent run's `subagent_tokens_used` (sub-agents spec §8.3): a usage event already in the
   * log (an idempotent hit after a crash) adds nothing, so each call counts exactly once. Returns
   * what was written (hits included) and the highest new seq (null: nothing new).
   */
  @Transactional({ propagation: "requires_new" })
  async appendCounted(
    conversationId: string,
    parentRunId: string,
    events: AppendEvent[],
  ): Promise<{ written: ConversationEvent[]; toSeq: number | null }> {
    const t = this.kdb.db;
    // the conversation row lock the append takes anyway, taken first to read the seq before it
    const before = await t
      .selectFrom("conversations")
      .select("last_seq")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const written = await this.eventLog.appendIn(conversationId, events);
    const fresh = written.filter((e) => e.seq > Number(before.last_seq));
    let tokens = 0;
    for (const e of fresh) if (e.type === "usage") tokens += usageTokens(e.payload);
    if (tokens > 0) {
      await t
        .updateTable("runs")
        .set({ subagent_tokens_used: sql`subagent_tokens_used + ${tokens}` })
        .where("id", "=", parentRunId)
        .execute();
    }
    return { written, toSeq: fresh.length > 0 ? Math.max(...fresh.map((e) => e.seq)) : null };
  }

  /** Appends events with their audit row (a hook denial). */
  @Transactional({ propagation: "requires_new" })
  async appendAudited(
    conversationId: string,
    events: AppendEvent[],
    entry: StepAuditEntry,
  ): Promise<ConversationEvent[]> {
    const out = await this.eventLog.appendIn(conversationId, events);
    await audit(this.kdb.db, entry);
    return out;
  }

  /**
   * Appends a `model_call` with the tool definitions its request sent, stored by fingerprint in
   * `tool_specs` in the same transaction (a request can be rebuilt from the log and the specs).
   */
  @Transactional({ propagation: "requires_new" })
  async appendWithSpecs(
    conversationId: string,
    specs: readonly { specHash: string; spec: ToolSpec }[],
    events: AppendEvent[],
  ): Promise<ConversationEvent[]> {
    await recordToolSpecs(this.kdb.db, specs);
    return this.eventLog.appendIn(conversationId, events);
  }
}
