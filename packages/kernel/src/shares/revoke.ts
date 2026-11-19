import { type ExpressionBuilder, sql } from "kysely";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { creatorStillHasAccess } from "./liveness.js";
import { oweShareObjectDelete } from "./share-objects.js";

/** The reasons of the revokes the kernel makes on its own (file sharing spec §9). */
export type LifecycleRevokeReason =
  | "conversation_deleted"
  | "member_offboarded"
  | "creator_lost_access";

/** Which shares a lifecycle revoke covers. */
export type LifecycleRevokeTarget =
  | { conversationId: string }
  | { orgId: string; createdBy: string }
  /** The daily sweep's batch (with `creator_lost_access`). */
  | { shareIds: readonly string[] };

/**
 * In the caller's transaction: marks the matching unrevoked rows revoked with `reason` (no
 * `revoked_by`: the kernel revokes, the act that caused it is audited by its own flow) and owes each
 * current snapshot's deletion through the outbox (`share-object-delete-<id>-<generation>`), so the
 * snapshot is freed right away, not at the daily sweep. Expired rows are revoked too: their snapshot
 * is freed with the rest. With `creator_lost_access` the creator's access is checked again in the
 * `UPDATE` (a cause that went away since the sweep read the row keeps the share). Each row is
 * locked by the `UPDATE`; a refresh committing concurrently is serialized on the row lock, so the
 * generation read back is the one current at the revoke. Returns the number of rows revoked.
 */
export async function revokeSharesIn(
  db: KernelSchemaDb,
  outbox: Pick<OutboxService, "add">,
  where: LifecycleRevokeTarget,
  reason: LifecycleRevokeReason,
): Promise<number> {
  if ("shareIds" in where && where.shareIds.length === 0) return 0;
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
  const revoked = await q.returning(["id", "org_id", "generation", "object_key"]).execute();
  for (const r of revoked) {
    if (r.object_key !== null) await oweShareObjectDelete(outbox, r.org_id, r.id, r.generation);
  }
  return revoked.length;
}
