import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StorageModule } from "../storage/storage.module.js";
import { StorageService } from "../storage/storage.service.js";

/**
 * Share snapshots in object storage (file sharing spec §1, §2): generation `n` of share `id` is the
 * object `shares/<id>/<n>` under the org's kernel prefix (`kernel/<orgId>/`). A snapshot is written
 * before the row that names it; deleting one is owed through the outbox
 * ({@link SHARE_OBJECT_DELETE_JOB}) by the transaction that stops using it (a refresh, a revoke).
 */

/** The object key of a share's generation, relative to the org's kernel prefix. */
export const shareObjectKey = (shareId: string, generation: number): string =>
  `shares/${shareId}/${generation}`;

/**
 * The lock (`LockService`) a refresh of one share holds while it copies and commits its next
 * generation; the daily sweep takes it before deleting a non-current generation of an existing share.
 */
export const shareRefreshLockKey = (shareId: string): string => `share-refresh-${shareId}`;

/** The maintenance job that deletes one share snapshot. */
export const SHARE_OBJECT_DELETE_JOB = "share-object-delete";

/** Deterministic outbox / BullMQ id of a snapshot's deletion (no `:`). */
export const shareObjectDeleteJobId = (shareId: string, generation: number): string =>
  `share-object-delete-${shareId}-${generation}`;

/** The data of a {@link SHARE_OBJECT_DELETE_JOB}. */
export interface ShareObjectDeleteData {
  orgId: string;
  shareId: string;
  generation: number;
  objectKey: string;
}

/** Owes the deletion of one share generation's snapshot, in the caller's transaction. */
export async function oweShareObjectDelete(
  outbox: Pick<OutboxService, "add">,
  orgId: string,
  shareId: string,
  generation: number,
): Promise<void> {
  const data: ShareObjectDeleteData = {
    orgId,
    shareId,
    generation,
    objectKey: shareObjectKey(shareId, generation),
  };
  await outbox.add({
    queue: MAINTENANCE_QUEUE_NAME,
    name: SHARE_OBJECT_DELETE_JOB,
    jobId: shareObjectDeleteJobId(shareId, generation),
    data,
    orgId,
  });
}

/**
 * Runs a {@link SHARE_OBJECT_DELETE_JOB} (the maintenance processor dispatches it here). Delivered
 * twice, it is harmless: deleting a missing object is a no-op. A snapshot a share may still serve
 * (the row is neither revoked nor expired and names the key) is never deleted, whatever the job
 * says; a revoked or expired row whose snapshot is gone gets its `object_key` cleared (the row stays
 * for the audit trail and the lists' recent section). Expiry is final (no route moves
 * `expires_at`), so an expired row never serves again. The daily sweep (`ShareSweepJob`) calls
 * {@link deleteObject} directly for expired shares and orphan snapshots.
 */
@Injectable()
export class ShareObjects {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
  ) {}

  /** Deletes the snapshot of one share generation; see the class comment. */
  async deleteObject(data: ShareObjectDeleteData): Promise<void> {
    if (data.objectKey !== shareObjectKey(data.shareId, data.generation)) {
      // never delete anything outside the share's own key, whatever the job data says
      throw new Error(`share-object-delete: unexpected object key for share ${data.shareId}`);
    }
    const row = await this.db
      .selectFrom("file_shares")
      .select([
        "object_key",
        "revoked_at",
        sql<boolean>`expires_at IS NOT NULL AND expires_at <= now()`.as("expired"),
      ])
      .where("id", "=", data.shareId)
      .where("org_id", "=", data.orgId)
      .executeTakeFirst();
    if (row && row.revoked_at === null && !row.expired && row.object_key === data.objectKey) return;
    const store = this.storage.kernel(data.orgId);
    if (await store.head(data.objectKey)) await store.delete(data.objectKey);
    await this.cleared(data);
  }

  /** Clears a revoked or expired row's `object_key` once its snapshot is gone. */
  @Transactional()
  async cleared(data: ShareObjectDeleteData): Promise<void> {
    await this.db
      .updateTable("file_shares")
      .set({ object_key: null })
      .where("id", "=", data.shareId)
      .where("org_id", "=", data.orgId)
      .where("object_key", "=", data.objectKey)
      .where((eb) =>
        eb.or([
          eb("revoked_at", "is not", null),
          eb.and([eb("expires_at", "is not", null), eb("expires_at", "<=", sql<Date>`now()`)]),
        ]),
      )
      .execute();
  }
}

/** {@link ShareObjects} for the maintenance worker (storage and the database only). */
@Module({ imports: [StorageModule], providers: [ShareObjects], exports: [ShareObjects] })
export class ShareObjectsModule {}
