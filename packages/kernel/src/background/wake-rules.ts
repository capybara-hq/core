import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { effectiveWakeOnBackgroundTask, readOrgSettings } from "../orgs/settings.service.js";

/**
 * The wake rules of a finished background task (spec 2026-11-05-background-bash-design §3), read
 * by `RunQueue.ensureRun` in its transaction: every path that may start a run (a finish, the end of
 * a run, the delayed wake job, a page opening) applies the same rules. `BackgroundWake` is what
 * calls `ensureRun` when a task finishes.
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
 * What a conversation's unconsumed finishes decide:
 * - `wake`: start a run whose boundary is the finish at `seq`, as `triggerAccountId`;
 * - `later`: a wake started less than {@link WAKE_WINDOW_MS} ago; the window ends at `windowEnd`
 *   (epoch ms, the database's clock), `delayMs` from now;
 * - null: nothing wakes the conversation.
 */
export type WakeDecision =
  | { kind: "wake"; seq: number; triggerAccountId: string }
  | { kind: "later"; windowEnd: number; delayMs: number }
  | null;

/** How many unconsumed finishes are tried for a trigger account that can still send. */
const CANDIDATES = 20;

/**
 * The wake decision for a chat conversation that is idle, whose queue is not paused and has no
 * unconsumed message (the caller checked these under the conversation's row lock). A finish
 * wakes it when:
 * - it is after `consumed`, not `reported` (a tool call already told the model) and not a
 *   person's stop (`stoppedBy: "person"`: that person is looking at the conversation);
 * - it belongs to a task of this conversation (the join on `conversation_id` reads the task's
 *   trigger account). A sub-agent's task is excluded by the conversation's kind, not here: its
 *   finish is in the child's log, and `ensureRun` never wakes a non-chat conversation;
 * - the wake setting is on (the org's override, else `deploymentOn`);
 * - the task's trigger account can still send to the conversation (`canSend`);
 * - no other wake started in the last {@link WAKE_WINDOW_MS} (else `later`).
 * The boundary is the newest finish whose trigger account can send.
 */
export async function wakeDecisionIn(
  t: KernelSchemaDb,
  conv: { id: string; orgId: string },
  consumed: number,
  deploymentOn: boolean,
  canSend: (accountId: string) => Promise<boolean>,
): Promise<WakeDecision> {
  const candidates = await t
    .selectFrom("conversation_events as e")
    .innerJoin("background_tasks as b", (j) =>
      j
        .on(sql<boolean>`b.id = e.payload ->> 'taskId'`)
        .onRef("b.conversation_id", "=", "e.conversation_id"),
    )
    .select(["e.seq", "b.trigger_account_id"])
    .where("e.conversation_id", "=", conv.id)
    .where("e.type", "=", "background_task_finished")
    .where("e.seq", ">", String(consumed))
    .where(sql<boolean>`(e.payload ->> 'reported')::boolean = false`)
    .where(sql<boolean>`e.payload ->> 'stoppedBy' IS DISTINCT FROM 'person'`)
    .orderBy("e.seq", "desc")
    .limit(CANDIDATES)
    .execute();
  if (candidates.length === 0) return null;
  const org = (await readOrgSettings(t, conv.orgId)).wakeOnBackgroundTask;
  if (!effectiveWakeOnBackgroundTask(deploymentOn, org)) return null;
  let boundary: { seq: number; triggerAccountId: string } | undefined;
  for (const c of candidates) {
    if (await canSend(c.trigger_account_id)) {
      boundary = { seq: Number(c.seq), triggerAccountId: c.trigger_account_id };
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
    .where("w.type", "=", "background_task_finished")
    .executeTakeFirst();
  if (last?.started != null) {
    const windowEnd = Number(last.started) + WAKE_WINDOW_MS;
    const now = Number(last.now);
    if (windowEnd > now) return { kind: "later", windowEnd, delayMs: windowEnd - now };
  }
  return { kind: "wake", ...boundary };
}
