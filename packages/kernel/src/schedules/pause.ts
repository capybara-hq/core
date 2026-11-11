import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import type { SchedulePauseReason } from "./types.js";

/**
 * Pauses an active live task for `reason` in the caller's transaction `t` (the fire job, the run
 * tracker, the delivery path); `by` is the account that caused it, null for the kernel. A task
 * already paused or ended keeps its state and reason. A plain function so the run tracker, which
 * the runtime imports, needs no service of the schedules domain.
 */
export async function pauseTaskIn(
  t: KernelSchemaDb,
  taskId: string,
  reason: SchedulePauseReason,
  by: string | null,
): Promise<void> {
  const row = await t
    .updateTable("scheduled_tasks")
    .set({
      status: "paused",
      pause_reason: reason,
      paused_by: by,
      next_run_at: null,
      updated_at: sql`now()`,
    })
    .where("id", "=", taskId)
    .where("status", "=", "active")
    .where("deleted_at", "is", null)
    .returning(["org_id", "account_id"])
    .executeTakeFirst();
  if (!row) return;
  await audit(t, {
    actorAccountId: by,
    orgId: row.org_id,
    action: "schedule.paused",
    target: taskId,
    detail: { reason, creator: row.account_id },
  });
}
