import type { KernelSchemaDb } from "../db/kernel-schema.js";

/**
 * Deletes the push registrations the given sessions posted (mobile app plan decision 3: a
 * registration follows its session). Session revocation calls it in the transaction that sets
 * `revoked_at`: the foreign key is `ON DELETE SET NULL` and revocation keeps the session row, so
 * nothing else removes them. No person audit entry is written (`session_revoked` is implied by the
 * revocation). Infra dependencies only, so `identity/sessions.ts` imports it without a cycle.
 */
export async function deletePushRegistrationsForSessions(
  db: KernelSchemaDb,
  sessionIds: readonly string[],
): Promise<number> {
  if (sessionIds.length === 0) return 0;
  const r = await db
    .deleteFrom("push_registrations")
    .where("session_id", "in", [...sessionIds])
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
