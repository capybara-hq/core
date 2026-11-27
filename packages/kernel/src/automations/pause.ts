import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import type { AutomationPauseReason } from "./types.js";

/**
 * Pauses an active live task for `reason` in the caller's transaction `t` (the fire job, the run
 * tracker, the delivery path); `by` is the account that caused it, null for the kernel. A task
 * already paused or ended keeps its state and reason. A plain function so the run tracker, which
 * the runtime imports, needs no service of the automations domain.
 */
// org-filter: only kernel paths call it (fire job, run tracker, scan job, channel outbound), each
// with the task id of a task row or task run row it already holds, never a caller-supplied id
export async function pauseTaskIn(
  t: KernelSchemaDb,
  taskId: string,
  reason: AutomationPauseReason,
  by: string | null,
): Promise<void> {
  const row = await t
    .updateTable("automations")
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
    action: "automation.paused",
    target: taskId,
    detail: { reason, creator: row.account_id },
  });
}
