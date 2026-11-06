import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { effectiveWakeOnBackgroundTask, readOrgSettings } from "../orgs/settings.service.js";

/**
 * The wake rules of an idle conversation (spec 2026-11-05-background-bash-design §3, generalized
 * by agent map spec §5.3 to a second event kind): a finished background task or a sub-agent's
 * delivery starts a run. Read by `RunQueue.ensureRun` in its transaction: every path that may start
 * a run (a finish, a delivery, the end of a run, the delayed wake job, a page opening) applies the
 * same rules. `BackgroundWake` is what calls `ensureRun` when a task finishes or a delivery lands.
 */

/** No two wakes of one conversation start within this window. */
export const WAKE_WINDOW_MS = 60_000;

/** The delayed job that wakes a conversation at the end of its window (`cap-kernel-maintenance`). */
export const BG_WAKE_JOB = "bg-wake";

/**
 * Its job id: one job per conversation and window end (no `:`). `retry` > 0 is a job that fired
 * before the window ended on the database's clock and scheduled itself again: a distinct id, since
 * BullMQ ignores an add under the id of the job still running.
 */
export const bgWakeJobId = (conversationId: string, windowEnd: number, retry = 0): string =>
  `bg-wake-${conversationId}-${windowEnd}${retry > 0 ? `-r${retry}` : ""}`;

export interface BgWakeJobData {
  conversationId: string;
  /** How many times this window's wake fired early (absent: none). */
  retry?: number;
}

/**
 * What a conversation's unconsumed wake events decide:
 * - `wake`: start a run whose boundary is the event at `seq`, as `triggerAccountId`;
 * - `later`: a wake started less than {@link WAKE_WINDOW_MS} ago; the window ends at `windowEnd`
 *   (epoch ms, the database's clock), `delayMs` from now;
 * - null: nothing wakes the conversation.
 */
export type WakeDecision =
  | { kind: "wake"; seq: number; triggerAccountId: string }
  | { kind: "later"; windowEnd: number; delayMs: number }
  | null;

/** How many unconsumed events are tried for a trigger account that can still send. */
const CANDIDATES = 20;

/** The event types whose run is a wake run (its boundary, `runs.trigger_seq`, is one of them). */
const WAKE_EVENT_TYPES = ["background_task_finished", "subagent_delivery"] as const;

/**
 * The wake decision for a conversation that is idle and has no unconsumed message (the caller
 * checked these under the conversation's row lock): a chat conversation (`rootId` = its own id) or
 * a sub-agent's (`rootId` = the root of its tree). An event wakes it when:
 * - it is after `consumed` and is either
 *   - a `background_task_finished` of a task of this conversation (the join on `conversation_id`
 *     reads the task's trigger account) that is not `reported` (a tool call already told the model)
 *     and has no `stoppedBy` (`"person"`: that person is looking at the conversation;
 *     `"deletion"`: the conversation is being deleted), or
 *   - a `subagent_delivery` (its own `triggerAccountId`: the trigger account of the child run that
 *     delivered it, agent map spec §7), except the finish of a child a person stopped
 *     (`abortedBy: "user"`), for the same reason as a person's task stop;
 * - the wake setting is on (the org's override, else `deploymentOn`);
 * - the root's queue is not paused and the root is not deleted (a paused root holds the wakes of
 *   the whole tree, agent map spec §5.3);
 * - the event's trigger account can still send to the root (`canSend`, which the caller binds to
 *   the root);
 * - no other wake of this conversation started in the last {@link WAKE_WINDOW_MS} (else `later`).
 * The boundary is the newest event whose trigger account can send.
 */
export async function wakeDecisionIn(
  t: KernelSchemaDb,
  conv: { id: string; orgId: string; rootId: string },
  consumed: number,
  deploymentOn: boolean,
  canSend: (accountId: string) => Promise<boolean>,
): Promise<WakeDecision> {
  const finishes = await t
    .selectFrom("conversation_events as e")
    .innerJoin("background_tasks as b", (j) =>
      j
        .on(sql<boolean>`b.id = e.payload ->> 'taskId'`)
        .onRef("b.conversation_id", "=", "e.conversation_id"),
    )
    .select(["e.seq", "b.trigger_account_id as account"])
    .where("e.conversation_id", "=", conv.id)
    .where("e.type", "=", "background_task_finished")
    .where("e.seq", ">", String(consumed))
    .where(sql<boolean>`(e.payload ->> 'reported')::boolean = false`)
    .where(sql<boolean>`e.payload ->> 'stoppedBy' IS NULL`)
    .orderBy("e.seq", "desc")
    .limit(CANDIDATES)
    .execute();
  const deliveries = await t
    .selectFrom("conversation_events as e")
    .select(["e.seq", sql<string>`e.payload ->> 'triggerAccountId'`.as("account")])
    .where("e.conversation_id", "=", conv.id)
    .where("e.type", "=", "subagent_delivery")
    .where("e.seq", ">", String(consumed))
    .where(sql<boolean>`e.payload ->> 'abortedBy' IS DISTINCT FROM 'user'`)
    .orderBy("e.seq", "desc")
    .limit(CANDIDATES)
    .execute();
  const candidates = [...finishes, ...deliveries]
    .sort((a, b) => Number(b.seq) - Number(a.seq))
    .slice(0, CANDIDATES);
  if (candidates.length === 0) return null;
  const org = (await readOrgSettings(t, conv.orgId)).wakeOnBackgroundTask;
  if (!effectiveWakeOnBackgroundTask(deploymentOn, org)) return null;
  const root = await t
    .selectFrom("conversations")
    .select(["queue_paused", "deleted_at"])
    .where("id", "=", conv.rootId)
    .executeTakeFirst();
  if (!root || root.queue_paused || root.deleted_at !== null) return null;
  let boundary: { seq: number; triggerAccountId: string } | undefined;
  for (const c of candidates) {
    if (await canSend(c.account)) {
      boundary = { seq: Number(c.seq), triggerAccountId: c.account };
      break;
    }
  }
  if (boundary === undefined) return null;
  // the window starts when the last wake run was created (PG, so every replica reads the same)
  const last = await t
    .selectFrom("runs as r")
    .innerJoin("conversation_events as w", (j) =>
      j.onRef("w.conversation_id", "=", "r.conversation_id").onRef("w.seq", "=", "r.trigger_seq"),
    )
    .select([
      sql<string | null>`floor(extract(epoch from max(r.created_at)) * 1000)::bigint`.as("started"),
      sql<string>`floor(extract(epoch from now()) * 1000)::bigint`.as("now"),
    ])
    .where("r.conversation_id", "=", conv.id)
    .where("w.type", "in", WAKE_EVENT_TYPES)
    .executeTakeFirst();
  if (last?.started != null) {
    const windowEnd = Number(last.started) + WAKE_WINDOW_MS;
    const now = Number(last.now);
    if (windowEnd > now) return { kind: "later", windowEnd, delayMs: windowEnd - now };
  }
  return { kind: "wake", ...boundary };
}
