import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { RunControl as RunControlService } from "../runtime/run-control.js";
import { notInvocable, type RenderedInvocation } from "../skills/invoke.js";
import {
  ConversationsService,
  type ResolvedExtra,
  type RunControl,
} from "./conversations.service.js";
import { EventLog, payloadJson } from "./event-log.js";
import type { ConversationEvent, LogContentBlock } from "./events.js";
import { userMessageIdemKey } from "./idem-keys.js";
import {
  alreadySent,
  appendQueuedIn,
  COLUMNS,
  checkText,
  itemNotFound,
  noNul,
  QUEUE_MAX_ITEMS,
  type QueuedFile,
  type QueuedSkill,
  type QueueInput,
  type QueueItem,
  type QueuePauseReason,
  type QueueRow,
  queuedSkillBlocked,
  queueFull,
  storedSkill,
  toItem,
  unpauseIfEmpty,
} from "./queue.js";

/**
 * The queue API (owner only, as the conversation): list, add, edit the text, delete, send now and
 * resume. Every change publishes `changed: queue`.
 */
@Injectable()
export class ConversationQueue {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(EventLog)
    private readonly eventLog: Pick<
      EventLog,
      "appendIn" | "notify" | "publishChanged" | "findByIdem"
    >,
    @Inject(ConversationsService)
    private readonly conversations: Pick<
      ConversationsService,
      "get" | "writable" | "resolveExtra" | "bindIn" | "checkPick" | "prepareQueuedSkill"
    >,
    /** Starts the conversation's next run (`ensureRun`). */
    @Inject(RunControlService) private readonly runs: Pick<RunControl, "ensureRun">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  async list(
    orgId: string,
    conversationId: string,
    accountId: string,
  ): Promise<{ items: QueueItem[]; paused: boolean; pauseReason?: QueuePauseReason }> {
    await this.conversations.get(orgId, conversationId, accountId);
    return this.listIn(conversationId);
  }

  @Transactional({ isolationLevel: "repeatable read" })
  private async listIn(
    conversationId: string,
  ): Promise<{ items: QueueItem[]; paused: boolean; pauseReason?: QueuePauseReason }> {
    const t = this.db.db;
    const conv = await t
      .selectFrom("conversations")
      .select(["queue_paused", "queue_pause_reason"])
      .where("id", "=", conversationId)
      .executeTakeFirstOrThrow();
    const rows = await t
      .selectFrom("conversation_queue")
      .select(COLUMNS)
      .where("conversation_id", "=", conversationId)
      .orderBy("position")
      .execute();
    const reason = conv.queue_paused ? conv.queue_pause_reason : null;
    return {
      items: rows.map(toItem),
      paused: conv.queue_paused,
      ...(reason !== null && { pauseReason: reason as QueuePauseReason }),
    };
  }

  /**
   * Queues a message. `@` resources are read now with the caller's credentials and stored with the
   * item, and uploaded files are bound to the conversation now, so sending later needs nobody's
   * credentials. The same `clientMessageId` again returns the queued item (`created: false`), or,
   * when it was already sent, the sent `user_message` with `item: null`. Then `ensureRun`: on an
   * idle conversation the item goes out at once.
   */
  async add(
    orgId: string,
    conversationId: string,
    accountId: string,
    input: QueueInput,
  ): Promise<{ item: QueueItem | null; event?: ConversationEvent; created: boolean }> {
    const conv = await this.conversations.writable(orgId, conversationId, accountId);
    const files = input.files ?? [];
    checkText(input.text, files.length, input.attachments?.length ?? 0, input.skill !== undefined);
    const prior = await this.prior(conversationId, input.clientMessageId);
    if (prior) return prior;
    // a cheap unlocked check first, so a full queue never reads `@` resources (slow, remote,
    // credentialed); the locked check below stays authoritative
    const { n: queued } = await this.db
      .selectFrom("conversation_queue")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("conversation_id", "=", conversationId)
      .executeTakeFirstOrThrow();
    if (Number(queued) >= QUEUE_MAX_ITEMS) throw queueFull();
    await this.conversations.checkPick(orgId, conv, accountId, input);
    // a skill invocation is rendered now, like the `@` resources (spec §4.5)
    const invoked = await this.conversations.prepareQueuedSkill(orgId, conv, accountId, input);
    const extra = await this.conversations.resolveExtra(orgId, accountId, input);
    const skill =
      invoked === undefined || input.skill === undefined
        ? undefined
        : storedSkill(input.skill.name, invoked);
    const out = await this.addIn(orgId, conversationId, accountId, input, files, skill, extra);
    if (out === null) {
      return (
        (await this.prior(conversationId, input.clientMessageId)) ?? { item: null, created: false }
      );
    }
    if (out.created) {
      await this.eventLog.publishChanged(conversationId, "queue");
      await this.runs.ensureRun(conversationId);
    }
    return { item: toItem(out.row), created: out.created };
  }

  // its own transaction: the caller notifies and publishes after the commit
  @Transactional({ propagation: "requires_new" })
  private async addIn(
    orgId: string,
    conversationId: string,
    accountId: string,
    input: QueueInput,
    files: readonly string[],
    skill: ReturnType<typeof storedSkill> | undefined,
    extra: ResolvedExtra,
  ): Promise<{ row: QueueRow; created: boolean } | null> {
    const t = this.db.db;
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const existing = await t
      .selectFrom("conversation_queue")
      .select(COLUMNS)
      .where("conversation_id", "=", conversationId)
      .where("client_message_id", "=", input.clientMessageId)
      .executeTakeFirst();
    if (existing) return { row: existing, created: false };
    if (await alreadySent(t, conversationId, input.clientMessageId)) return null;
    const { n, last } = await t
      .selectFrom("conversation_queue")
      .select((eb) => [
        eb.fn.countAll<string>().as("n"),
        eb.fn.max<string | null>("position").as("last"),
      ])
      .where("conversation_id", "=", conversationId)
      .executeTakeFirstOrThrow();
    if (Number(n) >= QUEUE_MAX_ITEMS) throw queueFull();
    const blocks = await this.conversations.bindIn(orgId, conversationId, accountId, files);
    const fileMeta: QueuedFile[] = blocks.flatMap((b) =>
      (b.type === "image" || b.type === "document") && b.source.kind === "ref"
        ? [{ attachmentId: b.source.attachmentId, name: b.name ?? "", mediaType: b.mediaType }]
        : [],
    );
    const row = await t
      .insertInto("conversation_queue")
      .values({
        id: randomUUID(),
        conversation_id: conversationId,
        account_id: accountId,
        position: last === null ? 1 : Number(last) + 1,
        text: noNul(input.text),
        content: payloadJson([
          ...(skill === undefined ? [] : [skill.first]),
          ...extra.blocks,
          ...blocks,
        ]),
        attachments: payloadJson(extra.attachments),
        files: JSON.stringify(fileMeta),
        client_message_id: input.clientMessageId,
        model: input.model === undefined ? null : JSON.stringify(input.model),
        effort: input.effort ?? null,
        skill: skill?.skill ?? null,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return { row, created: true };
  }

  /**
   * Changes a queued item's text (its resources and files stay as queued). A skill invocation's
   * text is its arguments: the skill is rendered again with them now (phase D Task 9).
   */
  async edit(
    orgId: string,
    conversationId: string,
    accountId: string,
    itemId: string,
    text: string,
  ): Promise<QueueItem> {
    const conv = await this.conversations.writable(orgId, conversationId, accountId);
    const before = await this.db
      .selectFrom("conversation_queue")
      .select("skill")
      .where("id", "=", itemId)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    if (!before) throw itemNotFound();
    const was = before.skill as QueuedSkill | null;
    const invoked =
      was === null
        ? undefined
        : await this.conversations.prepareQueuedSkill(orgId, conv, accountId, {
            skill: { name: was.invokedAs },
            text,
          });
    const row = await this.editIn(conversationId, itemId, text, invoked);
    await this.eventLog.publishChanged(conversationId, "queue");
    return toItem(row);
  }

  // its own transaction: the caller notifies and publishes after the commit
  @Transactional({ propagation: "requires_new" })
  private async editIn(
    conversationId: string,
    itemId: string,
    text: string,
    invoked: RenderedInvocation | undefined,
  ): Promise<QueueRow> {
    const t = this.db.db;
    const cur = await t
      .selectFrom("conversation_queue")
      .select(["attachments", "files", "content", "skill"])
      .where("id", "=", itemId)
      .where("conversation_id", "=", conversationId)
      .forUpdate()
      .executeTakeFirst();
    if (!cur) throw itemNotFound();
    const skill = cur.skill as QueuedSkill | null;
    checkText(
      text,
      (cur.files as unknown[]).length,
      (cur.attachments as unknown[]).length,
      skill !== null,
    );
    // an invocation's first block is its rendered text: replace it and the record
    const stored =
      skill === null || invoked === undefined ? undefined : storedSkill(skill.invokedAs, invoked);
    return t
      .updateTable("conversation_queue")
      .set({
        text: noNul(text),
        updated_at: sql`now()`,
        ...(stored !== undefined && {
          skill: stored.skill,
          content: payloadJson([stored.first, ...(cur.content as LogContentBlock[]).slice(1)]),
        }),
      })
      .where("id", "=", itemId)
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
  }

  async remove(
    orgId: string,
    conversationId: string,
    accountId: string,
    itemId: string,
  ): Promise<void> {
    await this.conversations.writable(orgId, conversationId, accountId);
    await this.removeIn(conversationId, itemId);
    await this.eventLog.publishChanged(conversationId, "queue");
  }

  // its own transaction: the caller notifies and publishes after the commit
  @Transactional({ propagation: "requires_new" })
  private async removeIn(conversationId: string, itemId: string): Promise<void> {
    const t = this.db.db;
    await this.lockConversation(conversationId);
    const gone = await t
      .deleteFrom("conversation_queue")
      .where("id", "=", itemId)
      .where("conversation_id", "=", conversationId)
      .returning("id")
      .executeTakeFirst();
    if (!gone) throw itemNotFound();
    await unpauseIfEmpty(t, conversationId);
  }

  /**
   * Sends a queued item now: it leaves the queue and is posted as a user message in the same
   * transaction (an interjection when a run is active; the items before it keep their place).
   * Racing the dispatcher, exactly one of them takes the item; the loser sees it gone (404).
   */
  async sendNow(
    orgId: string,
    conversationId: string,
    accountId: string,
    itemId: string,
  ): Promise<ConversationEvent> {
    await this.conversations.writable(orgId, conversationId, accountId);
    const { event, fresh, switched } = await this.sendNowIn(conversationId, itemId);
    if (fresh) await this.eventLog.notify(conversationId, event.seq);
    if (switched) await this.eventLog.publishChanged(conversationId, "selection");
    await this.eventLog.publishChanged(conversationId, "queue");
    await this.runs.ensureRun(conversationId);
    return event;
  }

  // its own transaction: the caller notifies and publishes after the commit
  @Transactional({ propagation: "requires_new" })
  private async sendNowIn(
    conversationId: string,
    itemId: string,
  ): Promise<{ event: ConversationEvent; switched: boolean; fresh: boolean }> {
    const t = this.db.db;
    await this.lockConversation(conversationId);
    const head = await t
      .selectFrom("conversation_queue")
      .select(["skill", "client_message_id"])
      .where("id", "=", itemId)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    if (!head) throw itemNotFound();
    // the skill is checked again, as at dispatch; a refused item stays queued
    if (!(await alreadySent(t, conversationId, head.client_message_id))) {
      const blocked = await queuedSkillBlocked(t, conversationId, head);
      if (blocked !== null) {
        throw notInvocable(blocked, (head.skill as QueuedSkill).invokedAs);
      }
    }
    const row = await t
      .deleteFrom("conversation_queue")
      .where("id", "=", itemId)
      .where("conversation_id", "=", conversationId)
      .returning(COLUMNS)
      .executeTakeFirst();
    if (!row) throw itemNotFound();
    const sent = await alreadySent(t, conversationId, row.client_message_id);
    const out = await appendQueuedIn(t, this.eventLog, conversationId, row);
    await unpauseIfEmpty(t, conversationId);
    return { ...out, fresh: !sent };
  }

  /** "Continue sending": clears the pause and lets `ensureRun` send the head item. */
  async resume(orgId: string, conversationId: string, accountId: string): Promise<void> {
    await this.conversations.writable(orgId, conversationId, accountId);
    await this.db
      .updateTable("conversations")
      .set({ queue_paused: false, queue_pause_reason: null })
      .where("id", "=", conversationId)
      .execute();
    await this.eventLog.publishChanged(conversationId, "queue");
    await this.runs.ensureRun(conversationId);
  }

  /** A queued item or a sent message for this client id (outside any transaction). */
  private async prior(
    conversationId: string,
    clientMessageId: string,
  ): Promise<{ item: QueueItem | null; event?: ConversationEvent; created: false } | null> {
    const row = await this.db
      .selectFrom("conversation_queue")
      .select(COLUMNS)
      .where("conversation_id", "=", conversationId)
      .where("client_message_id", "=", clientMessageId)
      .executeTakeFirst();
    if (row) return { item: toItem(row), created: false };
    const event = await this.eventLog.findByIdem(
      conversationId,
      userMessageIdemKey(clientMessageId),
    );
    return event ? { item: null, event, created: false } : null;
  }

  @Transactional({ propagation: "mandatory" })
  private async lockConversation(conversationId: string): Promise<void> {
    await this.db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }
}
