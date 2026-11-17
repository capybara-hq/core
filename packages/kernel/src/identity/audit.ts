import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * Writes one audit event (`action` is dotted lower-case English, e.g. `org.member.role_changed`)
 * through `db`: a service passes `this.db.db` (`KernelDb`: the context's transaction or the pool),
 * so the event commits or rolls back with the write it records.
 */
export async function audit(
  db: KernelSchemaDb,
  e: {
    /** The acting account; absent or null for the kernel itself (a job such as the scope sync). */
    actorAccountId?: string | null;
    actorTokenId?: string;
    orgId?: string;
    action: string;
    target?: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db
    .insertInto("audit_events")
    .values({
      actor_account_id: e.actorAccountId ?? null,
      actor_token_id: e.actorTokenId ?? null,
      org_id: e.orgId ?? null,
      action: e.action,
      target: e.target ?? null,
      detail: JSON.stringify(e.detail ?? {}),
    })
    .execute();
}
