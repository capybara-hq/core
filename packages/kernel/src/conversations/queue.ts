import { sql } from "kysely";
import { type ModelRef, normalizeStoredDefinition } from "../agents/definition.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import {
  type InvocationRecord,
  type RenderedInvocation,
  recordedSkillBlocked,
} from "../skills/invoke.js";
import type { AttachmentRef, ResolvedExtra } from "./conversations.service.js";
import { type AppendEvent, type EventLog, payloadJson } from "./event-log.js";
import type { ConversationEvent, LogContentBlock } from "./events.js";
import { userMessageIdemKey } from "./idem-keys.js";
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

/**
 * Why a queue paused (0062): a run failed or was stopped, the head item's author can no longer use
 * the conversation, or the head item's skill can no longer be invoked (phase D Task 9).
 */
export type QueuePauseReason = "run_ended" | "author_cannot_send" | "skill_not_invocable";

/**
 * A queued skill invocation (phase D Task 9), stored in `conversation_queue.skill`: the name the
 * person invoked (`<plugin>:<name>` or bare) and the `user_message.skill` record rendered with it.
 */
export interface QueuedSkill {
  invokedAs: string;
  record: InvocationRecord;
}

/** The caller's transaction handle (the module helpers below run inside it). */
type KernelTrx = KernelSchemaDb;

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
  /**
   * A skill invocation (phase D Task 9), rendered when queued; `text` is its arguments as typed.
   * `name` is the name the person invoked.
   */
  skill?: { name: string; arguments: string; mode: "inline" | "fork" };
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
  /** Invoke this skill (phase D): rendered now, `text` is the arguments. */
  skill?: { name: string };
}

export interface QueueRow {
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
  skill: unknown;
  created_at: Date;
}

export const COLUMNS = [
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
  "skill",
  "created_at",
] as const;

/**
 * Queued text as the event log will store it: NUL becomes U+FFFD (PG rejects NUL in text and
 * jsonb), the mapping `payloadJson` applies to a direct send (final review m1).
 */
export const noNul = (text: string): string => text.replaceAll("\0", "\uFFFD");

export const itemNotFound = () =>
  new ApiError("conversation.queue_item_not_found", "Queued message not found");

export function toItem(r: QueueRow): QueueItem {
  const skill = r.skill as QueuedSkill | null;
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
    ...(skill !== null && {
      skill: { name: skill.invokedAs, arguments: skill.record.arguments, mode: skill.record.mode },
    }),
    createdAt: r.created_at,
    position: Number(r.position),
  };
}

/**
 * The text rule of `POST …/messages`: text is required unless the message invokes a skill (its
 * rendered text is `content[0]`) or carries files and no `@` resources (`content[0]` must be the
 * text when resources follow it).
 */
export function checkText(text: string, files: number, attachments: number, skill: boolean): void {
  if (text.length > 0 || skill || (files > 0 && attachments === 0)) return;
  throw new ApiError("validation_failed", "Request validation failed", [
    {
      path: "text",
      message:
        "Text is required unless the message invokes a skill or carries files (and no @ resources)",
    },
  ]);
}

/** The stored form of a rendered invocation and its first content block. */
export function storedSkill(
  invokedAs: string,
  invoked: RenderedInvocation,
): { skill: string; first: LogContentBlock } {
  const skill: QueuedSkill = { invokedAs, record: invoked.skill };
  return { skill: payloadJson(skill), first: { type: "text", text: invoked.text } };
}

/** The `user_message` a queued item becomes, as `postUserMessage` would have written it. */
export function queuedUserMessage(r: QueueRow): AppendEvent {
  const attachments = r.attachments as ResolvedExtra["attachments"];
  const skill = r.skill as QueuedSkill | null;
  return {
    type: "user_message",
    idemKey: userMessageIdemKey(r.client_message_id),
    payload: {
      // a skill invocation's `content` starts with the text rendered when queued
      content: [
        ...(r.text === "" || skill !== null ? [] : [{ type: "text" as const, text: r.text }]),
        ...(r.content as LogContentBlock[]),
      ],
      ...(attachments.length > 0 && { attachments }),
      authorAccountId: r.account_id,
      clientMessageId: r.client_message_id,
      ...(skill !== null && { skill: skill.record }),
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
  eventLog: Pick<EventLog, "appendIn">,
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
  const written = await eventLog.appendIn(conversationId, events);
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
  return (await currentAgent(t, conversationId)).definition.model;
}

/** The conversation's org, agent and the agent's current definition (inside `t`). */
async function currentAgent(t: KernelTrx, conversationId: string) {
  const row = await t
    .selectFrom("conversations as c")
    .innerJoin("agents as a", "a.id", "c.agent_id")
    .innerJoin("agent_versions as v", (j) =>
      j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
    )
    .select(["c.org_id", "c.agent_id", "v.definition"])
    .where("c.id", "=", conversationId)
    .executeTakeFirstOrThrow();
  return {
    orgId: row.org_id,
    agentId: row.agent_id,
    definition: normalizeStoredDefinition(row.definition),
  };
}

/**
 * Why a queued item's skill can no longer be invoked, or null (also null for a plain message).
 * Checked at dispatch, inside `t` (phase D Task 9): the rendered text was frozen when queued, but
 * the skill must still be one of the agent's skills a person can invoke.
 */
export async function queuedSkillBlocked(
  t: KernelTrx,
  conversationId: string,
  r: Pick<QueueRow, "skill">,
) {
  const skill = r.skill as QueuedSkill | null;
  if (skill === null) return null;
  const a = await currentAgent(t, conversationId);
  return recordedSkillBlocked(t, {
    orgId: a.orgId,
    agentId: a.agentId,
    agent: a.definition,
    conversationId,
    skillId: skill.record.id,
  });
}

/** Pauses the queue with `reason` (inside `t`, holding the conversation row lock). */
export async function pauseQueueWith(
  t: KernelTrx,
  conversationId: string,
  reason: QueuePauseReason,
): Promise<void> {
  await t
    .updateTable("conversations")
    .set({ queue_paused: true, queue_pause_reason: reason })
    .where("id", "=", conversationId)
    .execute();
}

/** Whether a user_message with this client id is already in the log (inside `t`). */
export async function alreadySent(t: KernelTrx, conversationId: string, clientMessageId: string) {
  const row = await t
    .selectFrom("conversation_events")
    .select("seq")
    .where("conversation_id", "=", conversationId)
    .where("idem_key", "=", userMessageIdemKey(clientMessageId))
    .executeTakeFirst();
  return row !== undefined;
}

/** Clears the pause once the queue is empty (inside `t`, holding the conversation row lock). */
export async function unpauseIfEmpty(t: KernelTrx, conversationId: string): Promise<void> {
  await t
    .updateTable("conversations")
    .set({ queue_paused: false, queue_pause_reason: null })
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

export const queueFull = () =>
  new ApiError(
    "conversation.queue_full",
    `A conversation can hold at most ${QUEUE_MAX_ITEMS} queued messages`,
  );

/**
 * Sends the queue's head item as a `user_message` inside `t` (the caller holds the conversation
 * row lock and has checked the conversation is idle and not paused); returns the event, or null
 * when the queue is empty. An item whose message is already in the log (a retried enqueue after it
 * was sent) is dropped and the next one is taken. A head item whose skill can no longer be invoked
 * stays queued and the queue pauses (`skill_not_invocable`): `{ paused }`. The caller notifies
 * after commit.
 */
export async function dispatchQueuedIn(
  t: KernelTrx,
  eventLog: Pick<EventLog, "appendIn">,
  conversationId: string,
): Promise<{ event: ConversationEvent; switched: boolean } | { paused: QueuePauseReason } | null> {
  for (;;) {
    const head = await t
      .selectFrom("conversation_queue")
      .select(COLUMNS)
      .where("conversation_id", "=", conversationId)
      .orderBy("position")
      .limit(1)
      .executeTakeFirst();
    if (!head) return null;
    const sent = await alreadySent(t, conversationId, head.client_message_id);
    if (!sent && (await queuedSkillBlocked(t, conversationId, head)) !== null) {
      await pauseQueueWith(t, conversationId, "skill_not_invocable");
      return { paused: "skill_not_invocable" };
    }
    const row = await t
      .deleteFrom("conversation_queue")
      .where("id", "=", head.id)
      .returning(COLUMNS)
      .executeTakeFirst();
    if (!row || sent) continue;
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
    .set({ queue_paused: true, queue_pause_reason: "run_ended" satisfies QueuePauseReason })
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
