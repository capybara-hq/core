import type { KernelSchemaDb } from "../db/kernel-schema.js";

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
