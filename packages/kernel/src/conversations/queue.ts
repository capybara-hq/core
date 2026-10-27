import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { type ModelRef, normalizeStoredDefinition } from "../agents/definition.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import {
  type AttachmentRef,
  type ConversationsService,
  type ResolvedExtra,
  type RunControl,
  userMessageIdemKey,
} from "./conversations.service.js";
import type { AppendEvent, EventLog } from "./event-log.js";
import type { ConversationEvent, LogContentBlock } from "./events.js";
import { planSelection, readSelection } from "./selection.js";

/**
 * Queued messages (UI refresh B, spec §5.7): messages a person queued while a run was going. They
 * are conversation state in PG, not events: the model has not seen them, so they enter the log only
 * when sent. `RunQueue.ensureRun` sends the head item, one per run, when the conversation is idle
 * (no unconsumed message, no active run, not paused), under the conversation row lock, so exactly
 * one replica sends each item. A run that fails or is stopped pauses the queue (`finishRunIn`).
 */

/** The most messages a conversation can hold in its queue. */
export const QUEUE_MAX_ITEMS = 20;

type KernelTrx = Transaction<KernelDatabase>;

/** A queued message as the API returns it. */
export interface QueueItem {
  id: string;
  text: string;
  /** Uploaded files, bound to the conversation when queued. */
  files: QueuedFile[];
  /** `@` resources, read when queued (decision 15). */
  attachments: { connectorId: string; name: string; uri: string }[];
  clientMessageId: string;
  /** The model the message switches to when sent (null: no pick). */
  model: ModelRef | null;
  /** The effort the message switches to when sent (null: no pick). */
  effort: string | null;
  createdAt: Date;
  /** Increasing in queue order (not dense: deleted items leave gaps). */
  position: number;
}

export interface QueuedFile {
  attachmentId: string;
  name: string;
  mediaType: string;
}

/** What `POST …/queue` takes (the message fields that can be queued). */
export interface QueueInput {
  text: string;
  clientMessageId: string;
  attachments?: AttachmentRef[];
  files?: string[];
  /** A model / effort pick, applied when the message is sent (as a direct send's). */
  model?: ModelRef;
  effort?: string;
}

interface QueueRow {
  id: string;
  conversation_id: string;
  account_id: string;
  position: string;
  text: string;
  content: unknown;
  attachments: unknown;
  files: unknown;
  client_message_id: string;
  model: unknown;
  effort: string | null;
  created_at: Date;
}

const COLUMNS = [
  "id",
  "conversation_id",
  "account_id",
  "position",
  "text",
  "content",
  "attachments",
  "files",
  "client_message_id",
  "model",
  "effort",
  "created_at",
] as const;

const itemNotFound = () =>
  new ApiError("conversation.queue_item_not_found", "Queued message not found");

function toItem(r: QueueRow): QueueItem {
  return {
    id: r.id,
    text: r.text,
    files: r.files as QueuedFile[],
    attachments: (r.attachments as ResolvedExtra["attachments"]).map((a) => ({
      connectorId: a.appId,
      name: a.name,
      uri: a.uri,
    })),
    clientMessageId: r.client_message_id,
    model: (r.model as ModelRef | null) ?? null,
    effort: r.effort,
    createdAt: r.created_at,
    position: Number(r.position),
  };
}

/**
 * The text rule of `POST …/messages`: text is required unless the message carries files and no `@`
 * resources (`content[0]` must be the text when resources follow it).
 */
function checkText(text: string, files: number, attachments: number): void {
  if (text.length > 0 || (files > 0 && attachments === 0)) return;
  throw new ApiError("validation_failed", "Request validation failed", [
    {
      path: "text",
      message: "Text is required unless the message carries files (and no @ resources)",
    },
  ]);
}

/** The `user_message` a queued item becomes, as `postUserMessage` would have written it. */
export function queuedUserMessage(r: QueueRow): AppendEvent {
  const attachments = r.attachments as ResolvedExtra["attachments"];
  return {
    type: "user_message",
    idemKey: userMessageIdemKey(r.client_message_id),
    payload: {
      content: [
        ...(r.text === "" ? [] : [{ type: "text" as const, text: r.text }]),
        ...(r.content as LogContentBlock[]),
      ],
      ...(attachments.length > 0 && { attachments }),
      authorAccountId: r.account_id,
      clientMessageId: r.client_message_id,
    },
  };
}

/**
 * Appends a queued item inside `t` (the caller holds the conversation row lock): its pick, re-planned
 * against the selection in effect now, becomes a `model_switched` before the `user_message`, as a
 * direct send writes it (final review I1), and the cached selection follows the log. A model that
 * stopped resolving since the item was queued is still written: the run worker's fallback
 * (`model_switched { reason: "unavailable" }` before `run_started`) handles it, as it does for a
 * direct switch whose model disappears. Returns the `user_message` and whether it switched.
 */
export async function appendQueuedIn(
  t: KernelTrx,
  eventLog: Pick<EventLog, "append">,
  conversationId: string,
  r: QueueRow,
): Promise<{ event: ConversationEvent; switched: boolean }> {
  const events: AppendEvent[] = [];
  const pick = {
    ...(r.model !== null && { model: r.model as ModelRef }),
    ...(r.effort !== null && { effort: r.effort }),
  };
  const next =
    pick.model === undefined && pick.effort === undefined
      ? null
      : planSelection(
          await agentModel(t, conversationId),
          await readSelection(t, conversationId),
          pick,
        );
  if (next !== null) {
    events.push({
      type: "model_switched",
      idemKey: `switch:${r.client_message_id}`,
      payload: { ...next, byAccountId: r.account_id, reason: "user" },
    });
  }
  events.push(queuedUserMessage(r));
  const written = await eventLog.append(conversationId, events, t);
  if (next !== null) {
    await t
      .updateTable("conversations")
      .set({ selection: JSON.stringify(await readSelection(t, conversationId)) })
      .where("id", "=", conversationId)
      .execute();
  }
  return { event: written.at(-1) as ConversationEvent, switched: next !== null };
}

/** The model of the conversation agent's current version (inside `t`). */
async function agentModel(t: KernelTrx, conversationId: string): Promise<ModelRef> {
  const row = await t
    .selectFrom("conversations as c")
    .innerJoin("agents as a", "a.id", "c.agent_id")
    .innerJoin("agent_versions as v", (j) =>
      j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
    )
    .select("v.definition")
    .where("c.id", "=", conversationId)
    .executeTakeFirstOrThrow();
  return normalizeStoredDefinition(row.definition).model;
}

/** Whether a user_message with this client id is already in the log (inside `t`). */
async function alreadySent(t: KernelTrx, conversationId: string, clientMessageId: string) {
  const row = await t
    .selectFrom("conversation_events")
    .select("seq")
    .where("conversation_id", "=", conversationId)
    .where("idem_key", "=", userMessageIdemKey(clientMessageId))
    .executeTakeFirst();
  return row !== undefined;
}

/** Clears the pause once the queue is empty (inside `t`, holding the conversation row lock). */
async function unpauseIfEmpty(t: KernelTrx, conversationId: string): Promise<void> {
  await t
    .updateTable("conversations")
    .set({ queue_paused: false })
    .where("id", "=", conversationId)
    .where("queue_paused", "=", true)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("conversation_queue")
            .select(sql`1`.as("one"))
            .where("conversation_queue.conversation_id", "=", conversationId),
        ),
      ),
    )
    .execute();
}

/**
 * Sends the queue's head item as a `user_message` inside `t` (the caller holds the conversation
 * row lock and has checked the conversation is idle and not paused); returns the event, or null
 * when the queue is empty. An item whose message is already in the log (a retried enqueue after it
 * was sent) is dropped and the next one is taken. The caller notifies after commit.
 */
const queueFull = () =>
  new ApiError(
    "conversation.queue_full",
    `A conversation can hold at most ${QUEUE_MAX_ITEMS} queued messages`,
  );

export async function dispatchQueuedIn(
  t: KernelTrx,
  eventLog: Pick<EventLog, "append">,
  conversationId: string,
): Promise<{ event: ConversationEvent; switched: boolean } | null> {
  for (;;) {
    const head = await t
      .selectFrom("conversation_queue")
      .select("id")
      .where("conversation_id", "=", conversationId)
      .orderBy("position")
      .limit(1)
      .executeTakeFirst();
    if (!head) return null;
    const row = await t
      .deleteFrom("conversation_queue")
      .where("id", "=", head.id)
      .returning(COLUMNS)
      .executeTakeFirst();
    if (!row) continue;
    if (await alreadySent(t, conversationId, row.client_message_id)) continue;
    return appendQueuedIn(t, eventLog, conversationId, row);
  }
}

/**
 * Pauses the queue of a conversation whose run just failed or was stopped, when it holds items
 * (inside the terminal transaction, see `finishRunIn`).
 */
export async function pauseQueueIn(t: KernelTrx, conversationId: string): Promise<void> {
  await t
    .updateTable("conversations")
    .set({ queue_paused: true })
    .where("id", "=", conversationId)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("conversation_queue")
          .select(sql`1`.as("one"))
          .where("conversation_queue.conversation_id", "=", conversationId),
      ),
    )
    .execute();
}

export interface ConversationQueueDeps {
  db: KernelDb;
  eventLog: Pick<EventLog, "append" | "notify" | "publishChanged" | "findByIdem">;
  conversations: Pick<
    ConversationsService,
    "get" | "writable" | "resolveExtra" | "bindIn" | "checkFilesSupported" | "checkPick"
  >;
  runs?: Pick<RunControl, "ensureRun">;
}

/**
 * The queue API (owner only, as the conversation): list, add, edit the text, delete, send now and
 * resume. Every change publishes `changed: queue`.
 */
export class ConversationQueue {
  constructor(private readonly d: ConversationQueueDeps) {}

  async list(
    orgId: string,
    conversationId: string,
    accountId: string,
  ): Promise<{ items: QueueItem[]; paused: boolean }> {
    await this.d.conversations.get(orgId, conversationId, accountId);
    return this.d.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (t) => {
        const conv = await t
          .selectFrom("conversations")
          .select("queue_paused")
          .where("id", "=", conversationId)
          .executeTakeFirstOrThrow();
        const rows = await t
          .selectFrom("conversation_queue")
          .select(COLUMNS)
          .where("conversation_id", "=", conversationId)
          .orderBy("position")
          .execute();
        return { items: rows.map(toItem), paused: conv.queue_paused };
      });
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
    const conv = await this.d.conversations.writable(orgId, conversationId, accountId);
    this.d.conversations.checkFilesSupported(input);
    const files = input.files ?? [];
    checkText(input.text, files.length, input.attachments?.length ?? 0);
    const prior = await this.prior(conversationId, input.clientMessageId);
    if (prior) return prior;
    // a cheap unlocked check first, so a full queue never reads `@` resources (slow, remote,
    // credentialed); the locked check below stays authoritative
    const { n: queued } = await this.d.db
      .selectFrom("conversation_queue")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("conversation_id", "=", conversationId)
      .executeTakeFirstOrThrow();
    if (Number(queued) >= QUEUE_MAX_ITEMS) throw queueFull();
    await this.d.conversations.checkPick(orgId, conv, accountId, input);
    const extra = await this.d.conversations.resolveExtra(orgId, accountId, input);
    const out = await this.d.db.transaction().execute(async (t) => {
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
      const blocks = await this.d.conversations.bindIn(t, orgId, conversationId, accountId, files);
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
          text: input.text,
          content: JSON.stringify([...extra.blocks, ...blocks]),
          attachments: JSON.stringify(extra.attachments),
          files: JSON.stringify(fileMeta),
          client_message_id: input.clientMessageId,
          model: input.model === undefined ? null : JSON.stringify(input.model),
          effort: input.effort ?? null,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return { row, created: true };
    });
    if (out === null) {
      return (
        (await this.prior(conversationId, input.clientMessageId)) ?? { item: null, created: false }
      );
    }
    if (out.created) {
      await this.d.eventLog.publishChanged(conversationId, "queue");
      await this.d.runs?.ensureRun(conversationId);
    }
    return { item: toItem(out.row), created: out.created };
  }

  /** Changes a queued item's text (its resources and files stay as queued). */
  async edit(
    orgId: string,
    conversationId: string,
    accountId: string,
    itemId: string,
    text: string,
  ): Promise<QueueItem> {
    await this.d.conversations.writable(orgId, conversationId, accountId);
    const row = await this.d.db.transaction().execute(async (t) => {
      const cur = await t
        .selectFrom("conversation_queue")
        .select(["attachments", "files"])
        .where("id", "=", itemId)
        .where("conversation_id", "=", conversationId)
        .forUpdate()
        .executeTakeFirst();
      if (!cur) throw itemNotFound();
      checkText(text, (cur.files as unknown[]).length, (cur.attachments as unknown[]).length);
      return t
        .updateTable("conversation_queue")
        .set({ text, updated_at: sql`now()` })
        .where("id", "=", itemId)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
    });
    await this.d.eventLog.publishChanged(conversationId, "queue");
    return toItem(row);
  }

  async remove(
    orgId: string,
    conversationId: string,
    accountId: string,
    itemId: string,
  ): Promise<void> {
    await this.d.conversations.writable(orgId, conversationId, accountId);
    await this.d.db.transaction().execute(async (t) => {
      await this.lockConversation(t, conversationId);
      const gone = await t
        .deleteFrom("conversation_queue")
        .where("id", "=", itemId)
        .where("conversation_id", "=", conversationId)
        .returning("id")
        .executeTakeFirst();
      if (!gone) throw itemNotFound();
      await unpauseIfEmpty(t, conversationId);
    });
    await this.d.eventLog.publishChanged(conversationId, "queue");
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
    await this.d.conversations.writable(orgId, conversationId, accountId);
    const { event, fresh, switched } = await this.d.db.transaction().execute(async (t) => {
      await this.lockConversation(t, conversationId);
      const row = await t
        .deleteFrom("conversation_queue")
        .where("id", "=", itemId)
        .where("conversation_id", "=", conversationId)
        .returning(COLUMNS)
        .executeTakeFirst();
      if (!row) throw itemNotFound();
      const sent = await alreadySent(t, conversationId, row.client_message_id);
      const out = await appendQueuedIn(t, this.d.eventLog, conversationId, row);
      await unpauseIfEmpty(t, conversationId);
      return { ...out, fresh: !sent };
    });
    if (fresh) await this.d.eventLog.notify(conversationId, event.seq);
    if (switched) await this.d.eventLog.publishChanged(conversationId, "selection");
    await this.d.eventLog.publishChanged(conversationId, "queue");
    await this.d.runs?.ensureRun(conversationId);
    return event;
  }

  /** "Continue sending": clears the pause and lets `ensureRun` send the head item. */
  async resume(orgId: string, conversationId: string, accountId: string): Promise<void> {
    await this.d.conversations.writable(orgId, conversationId, accountId);
    await this.d.db
      .updateTable("conversations")
      .set({ queue_paused: false })
      .where("id", "=", conversationId)
      .execute();
    await this.d.eventLog.publishChanged(conversationId, "queue");
    await this.d.runs?.ensureRun(conversationId);
  }

  /** A queued item or a sent message for this client id (outside any transaction). */
  private async prior(
    conversationId: string,
    clientMessageId: string,
  ): Promise<{ item: QueueItem | null; event?: ConversationEvent; created: false } | null> {
    const row = await this.d.db
      .selectFrom("conversation_queue")
      .select(COLUMNS)
      .where("conversation_id", "=", conversationId)
      .where("client_message_id", "=", clientMessageId)
      .executeTakeFirst();
    if (row) return { item: toItem(row), created: false };
    const event = await this.d.eventLog.findByIdem(
      conversationId,
      userMessageIdemKey(clientMessageId),
    );
    return event ? { item: null, event, created: false } : null;
  }

  private async lockConversation(t: KernelTrx, conversationId: string): Promise<void> {
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }
}
