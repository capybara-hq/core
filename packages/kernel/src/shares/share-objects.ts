import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { StorageModule } from "../storage/storage.module.js";
import { StorageService } from "../storage/storage.service.js";

/**
 * Share snapshots of before the file library (file sharing spec §1, §2): generation `n` of share
 * `id` was the object `shares/<id>/<n>` under the org's kernel prefix (`kernel/<orgId>/`), and
 * deleting one was owed through the outbox ({@link SHARE_OBJECT_DELETE_JOB}). Shares now point at
 * blobs (file library spec §1; 0189 made every snapshot a blob keeping its key) and nothing owes this
 * job any more; its handler stays for the rows owed before the deploy and for old replicas during
 * a rolling deploy, and never deletes a key a blob uses.
 */

/** The object key of a share's generation, relative to the org's kernel prefix. */
export const shareObjectKey = (shareId: string, generation: number): string =>
  `shares/${shareId}/${generation}`;

/**
 * The lock (`LockService`) a refresh of one share holds while it picks and commits its next
 * generation, so two refreshes of one share never race for the same generation.
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

/**
 * Runs a {@link SHARE_OBJECT_DELETE_JOB} (the maintenance processor dispatches it here) for the rows
 * owed before the file library (or by an old replica during the rolling deploy). Delivered twice, it
 * is harmless: deleting a missing object is a no-op. A key any blob of the org uses (0189 made every
 * snapshot a blob keeping its key) is never deleted: the blob sweep owns it. A snapshot an old
 * replica's share may still serve (the row is neither revoked nor expired and names the key) is never
 * deleted either. `object_key` is never cleared (file library amendment K7: the contract migration
 * drops the column).
 */
@Injectable()
export class ShareObjects {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
  ) {}

  /** Deletes the snapshot of one share generation; see the class comment. */
  async deleteObject(data: ShareObjectDeleteData): Promise<void> {
    if (data.objectKey !== shareObjectKey(data.shareId, data.generation)) {
      // never delete anything outside the share's own key, whatever the job data says
      throw new Error(`share-object-delete: unexpected object key for share ${data.shareId}`);
    }
    const blob = await this.db
      .selectFrom("blobs")
      .select("id")
      .where("org_id", "=", data.orgId)
      .where("object_key", "=", data.objectKey)
      .executeTakeFirst();
    if (blob) return;
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
  }
}

/** {@link ShareObjects} for the maintenance worker (storage and the database only). */
@Module({ imports: [StorageModule], providers: [ShareObjects], exports: [ShareObjects] })
export class ShareObjectsModule {}
