import { type ExpressionBuilder, sql } from "kysely";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
import { creatorStillHasAccess } from "./liveness.js";

/** The reasons of the revokes the kernel makes on its own (file sharing spec §9, file library §6). */
export type LifecycleRevokeReason =
  | "conversation_deleted"
  | "member_offboarded"
  | "creator_lost_access"
  | "file_deleted";

/** Which shares a lifecycle revoke covers. */
export type LifecycleRevokeTarget =
  | { conversationId: string }
  | { orgId: string; createdBy: string }
  /** The daily sweep's batch (with `creator_lost_access`). */
  | { shareIds: readonly string[] }
  /** The shares made from these library files (with `file_deleted`, in the deleting transaction). */
  | { orgId: string; fileIds: readonly string[] };

/**
 * In the caller's transaction: marks the matching unrevoked rows revoked with `reason` (no
 * `revoked_by`: the kernel revokes, the act that caused it is audited by its own flow). Expired rows
 * are revoked too. With `creator_lost_access` the creator's access is checked again in the `UPDATE`
 * (a cause that went away since the sweep read the row keeps the share). Each row is locked by the
 * `UPDATE`; a refresh committing concurrently is serialized on the row lock. Returns the number of
 * rows revoked.
 *
 * No deletion is owed: a share points at a blob (file library spec §1), which the blob sweep frees
 * once no file or live share needs it; the share sweep stops pointing at it after the retention.
 */
export async function revokeSharesIn(
  db: KernelSchemaDb,
  where: LifecycleRevokeTarget,
  reason: LifecycleRevokeReason,
): Promise<number> {
  if ("shareIds" in where && where.shareIds.length === 0) return 0;
  if ("fileIds" in where && where.fileIds.length === 0) return 0;
  let q = db
    .updateTable("file_shares")
    .set({
      revoked_at: sql<Date>`now()`,
      revoke_reason: reason,
      updated_at: sql<Date>`now()`,
    })
    .where("revoked_at", "is", null);
  if ("conversationId" in where) {
    q = q.where("conversation_id", "=", where.conversationId);
  } else if ("shareIds" in where) {
    q = q.where("id", "in", [...where.shareIds]);
  } else if ("fileIds" in where) {
    const ids = [...where.fileIds];
    q = q
      .where("org_id", "=", where.orgId)
      .where((eb) => eb.or([eb("source_file_id", "in", ids), eb("file_id", "in", ids)]));
  } else {
    q = q.where("org_id", "=", where.orgId).where("created_by", "=", where.createdBy);
  }
  if (reason === "creator_lost_access") {
    q = q.where((eb) =>
      eb.not(
        creatorStillHasAccess(eb as unknown as ExpressionBuilder<KernelDatabase, "file_shares">),
      ),
    );
  }
  const revoked = await q.returning(["id"]).execute();
  return revoked.length;
}
