import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { readScheduleSettings } from "./effective-settings.js";

/**
 * The scheduled task run a kernel run serves (scheduled tasks spec §4, §7), or null for an attended
 * run: `runs.scheduled_task_run_id`, set on the run a task's message triggered and inherited by the
 * runs descending from it without a person (sub-agent runs, wake runs). A run whose task run row is
 * gone is treated as attended.
 */
export async function unattendedTaskRunOf(
  db: KernelSchemaDb,
  runId: string,
): Promise<{ taskRunId: string; taskId: string; trial: boolean } | null> {
  const row = await db
    .selectFrom("runs as r")
    .innerJoin("scheduled_task_runs as tr", "tr.id", "r.scheduled_task_run_id")
    .select(["tr.id", "tr.task_id", "tr.trial"])
    .where("r.id", "=", runId)
    .executeTakeFirst();
  return row ? { taskRunId: row.id, taskId: row.task_id, trial: row.trial } : null;
}

/**
 * The `scheduled_task_run_id` a new run whose boundary (`runs.trigger_seq`) is event `seq` of
 * `conversationId` gets (scheduled tasks spec §4), read in the caller's transaction:
 * - a `user_message`: its schedule marker's task run; a sub-agent's task or `SendMessage` message
 *   (`dispatch`): what its parent run has; a person's message: null;
 * - a `background_task_finished`: what the run that launched the task has;
 * - a `subagent_delivery`: what the child run that delivered it has (it inherited from its parent);
 * - anything else, or no such event: null.
 */
export async function scheduledTaskRunAt(
  t: KernelSchemaDb,
  conversationId: string,
  seq: number | string,
): Promise<string | null> {
  const ev = await t
    .selectFrom("conversation_events")
    .select(["type", "payload"])
    .where("conversation_id", "=", conversationId)
    .where("seq", "=", String(seq))
    .executeTakeFirst();
  if (!ev) return null;
  const p = ev.payload as {
    schedule?: { taskRunId?: unknown };
    dispatch?: { parentRunId?: unknown };
    taskId?: unknown;
    childRunId?: unknown;
  };
  let runId: string | undefined;
  if (ev.type === "user_message") {
    if (typeof p.schedule?.taskRunId === "string") return p.schedule.taskRunId;
    if (typeof p.dispatch?.parentRunId === "string") runId = p.dispatch.parentRunId;
  } else if (ev.type === "background_task_finished" && typeof p.taskId === "string") {
    const task = await t
      .selectFrom("background_tasks")
      .select("run_id")
      .where("id", "=", p.taskId)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    runId = task?.run_id;
  } else if (ev.type === "subagent_delivery" && typeof p.childRunId === "string") {
    runId = p.childRunId;
  }
  if (runId === undefined) return null;
  const run = await t
    .selectFrom("runs")
    .select("scheduled_task_run_id")
    .where("id", "=", runId)
    .executeTakeFirst();
  return run?.scheduled_task_run_id ?? null;
}

/** The tool result of an ask outside the task's grants in an unattended run, `fail` mode (§7). */
export const UNATTENDED_ASK_ERROR = (tool: string) =>
  `This scheduled run cannot ask for approval; the task's owner can add ${tool} to the task's approved tools.`;

/** The result of `AskUserQuestion` (or any other input request) in an unattended run, `fail` mode. */
export const UNATTENDED_QUESTION_ERROR =
  "No one is present in this scheduled run; decide with the information you have, or state the open question in your final answer.";

/** The result of a call that needs the creator's personal connection, unattended, `fail` mode. */
export const UNATTENDED_CONNECTION_ERROR = (connector: string) =>
  `This scheduled run cannot ask the user to connect ${connector}; the task's owner can connect it before the next run.`;

/** The note on a connector call whose elicitation was declined in an unattended run (`fail`). */
export const UNATTENDED_ELICITATION_NOTE =
  "[The app asked for user input, but no one is present in this scheduled run, so the request was declined. Decide with the information you have, or state the open question in your final answer.]";

/** The `missing_grants` entry of a personal connector the creator has not connected (§7). */
export const connectionGrantKey = (connectorSlug: string) => `connection:${connectorSlug}`;

/**
 * What the tool policy knows of the scheduled task run a kernel run serves (`PolicyContext`): the
 * task (its grants), the task run (its `missing_grants`), whether it is a trial run (attended), and
 * the org's `unattendedAsk` and `forbiddenTools`, read live.
 */
export interface UnattendedRun {
  taskId: string;
  taskRunId: string;
  trial: boolean;
  unattendedAsk: "fail" | "wait";
  forbiddenTools: string[];
}

/** An unattended run that is not a trial run: the §7 rules apply. */
export const unattendedRules = (u: UnattendedRun | null | undefined): u is UnattendedRun =>
  u !== null && u !== undefined && !u.trial;

/** In `fail` mode, an unattended run never waits for a person (§7). */
export const unattendedFails = (u: UnattendedRun | null | undefined): boolean =>
  unattendedRules(u) && u.unattendedAsk === "fail";

/**
 * Whether the task's creator joined the run (scheduled tasks rulings, Task 7 and Task 8): the run's
 * conversation holds a `user_message` after the run's boundary (`trigger_seq`) that the creator
 * wrote (no schedule marker, no sub-agent dispatch, `authorAccountId` = the task's account) and
 * that the run already absorbed (at or below the `absorbedUpToSeq` of its latest model call). The
 * rest of such a run is attended. Another person's message (someone replying in a group thread the
 * task posted into) does not make it attended: the task's grants are the creator's, and only the
 * creator is the one asked.
 */
async function personJoined(db: KernelSchemaDb, runId: string): Promise<boolean> {
  const row = await db
    .selectFrom("runs as r")
    .innerJoin("scheduled_task_runs as tr", "tr.id", "r.scheduled_task_run_id")
    .innerJoin("scheduled_tasks as st", "st.id", "tr.task_id")
    .select(
      sql<boolean>`EXISTS (
        SELECT 1 FROM capybara.conversation_events u
        WHERE u.conversation_id = r.conversation_id
          AND u.type = 'user_message'
          AND u.seq > r.trigger_seq
          AND NOT (u.payload ? 'schedule')
          AND NOT (u.payload ? 'dispatch')
          AND u.payload->>'authorAccountId' = st.account_id
          AND u.seq <= (
            SELECT COALESCE((m.payload->'request'->>'absorbedUpToSeq')::bigint, m.seq)
            FROM capybara.conversation_events m
            WHERE m.conversation_id = r.conversation_id AND m.run_id = r.id
              AND m.type = 'model_call'
            ORDER BY m.seq DESC
            LIMIT 1
          )
      )`.as("joined"),
    )
    .where("r.id", "=", runId)
    .executeTakeFirst();
  return row?.joined === true;
}

/**
 * The scheduled task context of a run's tool calls (`PolicyContext.unattended`), or null when the
 * run is attended: it serves no task run, or a person's message joined it ({@link personJoined}).
 * A trial run is returned with `trial: true` (attended; its approvals become task grants).
 */
export async function unattendedRunOf(
  db: KernelSchemaDb,
  config: Pick<KernelConfigService, "get">,
  orgId: string,
  runId: string,
): Promise<UnattendedRun | null> {
  const run = await unattendedTaskRunOf(db, runId);
  if (run === null) return null;
  if (!run.trial && (await personJoined(db, runId))) return null;
  const s = await readScheduleSettings(db, config, orgId);
  return { ...run, unattendedAsk: s.unattendedAsk, forbiddenTools: s.forbiddenTools };
}

/**
 * Appends a key to a task run's `missing_grants` (a tool key, or `connection:<slug>`), once: one
 * atomic update, so parallel calls of a run and of its sub-agents never lose or repeat a key.
 */
export async function appendMissingGrant(
  db: KernelSchemaDb,
  taskRunId: string,
  key: string,
): Promise<void> {
  await db
    .updateTable("scheduled_task_runs")
    .set({
      missing_grants: sql<string>`CASE WHEN missing_grants ? ${key} THEN missing_grants
        ELSE missing_grants || jsonb_build_array(${key}::text) END`,
    })
    .where("id", "=", taskRunId)
    .execute();
}
