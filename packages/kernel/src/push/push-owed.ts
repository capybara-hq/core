import { Inject, Injectable, Module } from "@nestjs/common";
import type { ConversationEvent } from "../conversations/events.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { type OutboxJob, OutboxService } from "../infra/outbox/outbox.service.js";
import {
  automationRunEventId,
  conversationEventId,
  inboxItemEventId,
  PUSH_FANOUT_JOB,
  PUSH_QUEUE,
  type PushFanoutData,
  pushFanoutJobId,
} from "./jobs.js";
import { PushHostModule, PushProviderHost } from "./provider-host.js";
import { pushTriggerOf } from "./triggers.js";

/**
 * Owes the push fanout of a trigger event in the event's own transaction (mobile app spec §9.4):
 * one `push-fanout` outbox row per event, under `push-fanout-<eventId>`, naming the event by id
 * only (recipients are resolved when the job runs). Nothing is written while no `push-provider`
 * is loaded (plan decision 10), for an eval conversation, or for a run's end outside a chat
 * conversation.
 */
@Injectable()
export class PushOwed {
  constructor(
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add" | "addMany">,
    @Inject(PushProviderHost) private readonly host: Pick<PushProviderHost, "any">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /**
   * The fanouts of `events`, just appended to `conversationId` (of `kind`), in the caller's
   * transaction.
   */
  @Transactional({ propagation: "mandatory" })
  async oweIn(
    conversationId: string,
    orgId: string,
    kind: string,
    events: readonly ConversationEvent[],
  ): Promise<void> {
    if (kind === "eval") return;
    const owed = events.filter((e) => {
      const t = pushTriggerOf(e);
      return t !== null && (t.category !== "replies" || kind === "chat");
    });
    if (owed.length === 0 || !this.host.any()) return;
    await this.outbox.addMany(
      owed.map((e) =>
        fanoutJob(conversationEventId(conversationId, e.seq), orgId, {
          kind: "conversation",
          conversationId,
          seq: e.seq,
        }),
      ),
    );
  }

  /**
   * The fanout of an automation run's settle (completed or failed), in the caller's
   * transaction.
   */
  @Transactional({ propagation: "mandatory" })
  async oweAutomationRun(taskRunId: string, orgId: string): Promise<void> {
    if (!this.host.any()) return;
    await this.outbox.add(
      fanoutJob(automationRunEventId(taskRunId), orgId, { kind: "automation", taskRunId }),
    );
  }

  /** The fanout of a personal inbox item just posted, in the caller's transaction. */
  @Transactional({ propagation: "mandatory" })
  async oweInboxItem(itemId: string, orgId: string): Promise<void> {
    if (!this.host.any()) return;
    await this.outbox.add(fanoutJob(inboxItemEventId(itemId), orgId, { kind: "inbox", itemId }));
  }
}

function fanoutJob(
  eventId: string,
  orgId: string,
  source: PushFanoutData["source"],
): OutboxJob<PushFanoutData> {
  return {
    queue: PUSH_QUEUE,
    name: PUSH_FANOUT_JOB,
    jobId: pushFanoutJobId(eventId),
    data: { eventId, source },
    orgId,
  };
}

/**
 * {@link PushOwed}: infra and the extension registry only, so the event log and the automation
 * run tracker import it without a cycle.
 */
@Module({ imports: [PushHostModule], providers: [PushOwed], exports: [PushOwed] })
export class PushOwedModule {}
