import { Inject, Injectable, Module } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StorageModule } from "../storage/storage.module.js";
import { StorageService } from "../storage/storage.service.js";

/**
 * Blob and staging objects of the file library (file library spec §1, §3 and its builder
 * amendment), all relative to the org's kernel prefix (`kernel/<orgId>/`): every blob the kernel
 * writes is `blobs/<blobId>` (a key no upload form can write; a delivery's bytes and a finalized
 * upload's verified copy alike), and an upload stages at `uploads/<fileId>` (a migrated upload kept
 * its old key in `files.staging_key`). A staging object is never a blob. Deleting either kind is
 * owed through the outbox by the transaction that stops using it; the handlers re-read the rows.
 */

/** The object key of a blob the kernel writes, relative to the org prefix. */
export const blobObjectKey = (blobId: string): string => `blobs/${blobId}`;

/** The staging key a new upload is presigned to, relative to the org prefix. */
export const stagingObjectKey = (fileId: string): string => `uploads/${fileId}`;

/**
 * How long a presigned upload form stays valid (seconds). Within it the uploader can write the
 * staging object again; finalize copies the verified bytes to a kernel-owned key, so that only
 * ever changes the uploader's own staging object.
 */
export const FILE_UPLOAD_TTL_SECONDS = 300;

/**
 * Slack added to a form's lifetime before an owed deletion of its staging object runs, so a form
 * used again just before it expires cannot leave an object behind the deletion.
 */
const FORM_SLACK_SECONDS = 60;

/** When an owed deletion of a file's staging object may run: after its upload form expired. */
export function afterUploadForm(fileCreatedAt: Date): Date | undefined {
  const at = fileCreatedAt.getTime() + (FILE_UPLOAD_TTL_SECONDS + FORM_SLACK_SECONDS) * 1000;
  return at > Date.now() ? new Date(at) : undefined;
}

/** The maintenance job that deletes one blob in `deleting` status (its object, then its row). */
export const BLOB_DELETE_JOB = "blob-delete";
/** The maintenance job that deletes one upload's staging object no blob adopted. */
export const FILE_STAGING_DELETE_JOB = "file-staging-delete";

/** Deterministic outbox / BullMQ id of a blob's deletion (no `:`). */
export const blobDeleteJobId = (blobId: string): string => `blob-delete-${blobId}`;
/** Deterministic outbox / BullMQ id of a staging object's deletion (no `:`). */
export const fileStagingDeleteJobId = (fileId: string): string => `file-staging-delete-${fileId}`;

/** The data of a {@link BLOB_DELETE_JOB}. */
export interface BlobDeleteData {
  orgId: string;
  blobId: string;
}

/** The data of a {@link FILE_STAGING_DELETE_JOB}. */
export interface FileStagingDeleteData {
  orgId: string;
  fileId: string;
  objectKey: string;
}

/** Owes the deletion of a blob already set to `deleting`, in the caller's transaction. */
export async function oweBlobDelete(
  outbox: Pick<OutboxService, "add">,
  orgId: string,
  blobId: string,
  runAt?: Date,
): Promise<void> {
  const data: BlobDeleteData = { orgId, blobId };
  await outbox.add({
    queue: MAINTENANCE_QUEUE_NAME,
    name: BLOB_DELETE_JOB,
    jobId: blobDeleteJobId(blobId),
    data,
    orgId,
    ...(runAt !== undefined && { runAt }),
  });
}

/** Owes the deletion of a file's staging object, in the caller's transaction. */
export async function oweStagingDelete(
  outbox: Pick<OutboxService, "add">,
  orgId: string,
  fileId: string,
  objectKey: string,
  runAt?: Date,
): Promise<void> {
  const data: FileStagingDeleteData = { orgId, fileId, objectKey };
  await outbox.add({
    queue: MAINTENANCE_QUEUE_NAME,
    name: FILE_STAGING_DELETE_JOB,
    jobId: fileStagingDeleteJobId(fileId),
    data,
    orgId,
    ...(runAt !== undefined && { runAt }),
  });
}

/**
 * Runs the {@link BLOB_DELETE_JOB} and {@link FILE_STAGING_DELETE_JOB} jobs (the maintenance
 * processor dispatches them here). Delivered twice, each is harmless: deleting a missing object is
 * a no-op and the rows are read again first.
 *
 * - A staging object is deleted only when the key is the file's own staging key, the file is no
 *   longer an upload in progress, and no blob of the org names that key (a blob adopted it).
 * - A blob is deleted only while its row is `deleting` and no file or share points at it, checked
 *   under `FOR UPDATE` on the blob row; then its object goes, then its row. The invariant that
 *   makes the check final: every transaction that inserts or moves a reference to a blob (a file
 *   row, a share, a repoint) first calls `BlobsService.lockReady`, which locks the blob `FOR SHARE`
 *   and requires `ready`, so once a `deleting` blob is seen unreferenced under the lock, nothing can
 *   point at it again. A blob still referenced is left alone and logged: nothing turns a
 *   referenced blob into `deleting`, so that is a bug to look at, never bytes to drop.
 */
@Injectable()
export class BlobObjects {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /** Deletes one staging object; see the class comment. */
  async deleteStaging(data: FileStagingDeleteData): Promise<void> {
    const file = await this.db
      .selectFrom("files")
      .select([
        "status",
        "staging_key",
        sql<boolean>`expires_at IS NOT NULL AND expires_at <= now()`.as("expired"),
      ])
      .where("id", "=", data.fileId)
      .where("org_id", "=", data.orgId)
      .executeTakeFirst();
    const ownKey =
      data.objectKey === stagingObjectKey(data.fileId) ||
      (file !== undefined && file.staging_key === data.objectKey);
    if (!ownKey) {
      // never delete anything outside the file's own staging key, whatever the job data says
      throw new Error(`file-staging-delete: unexpected object key for file ${data.fileId}`);
    }
    // an upload still in progress may yet be finalized
    if (file?.status === "uploading" && !file.expired) return;
    const adopted = await this.db
      .selectFrom("blobs")
      .select("id")
      .where("org_id", "=", data.orgId)
      .where("object_key", "=", data.objectKey)
      .executeTakeFirst();
    if (adopted) return;
    await this.storage.kernel(data.orgId).delete(data.objectKey);
  }

  /** Deletes one `deleting` blob, its object first; see the class comment. */
  async deleteBlob(data: BlobDeleteData): Promise<void> {
    const key = await this.claimUnreferenced(data);
    if (key === null) return;
    await this.storage.kernel(data.orgId).delete(key);
    await this.dropRow(data);
  }

  /**
   * Under `FOR UPDATE` on the blob: its object key when it is `deleting` and nothing points at it,
   * else null (logged when it is still referenced).
   */
  @Transactional()
  async claimUnreferenced(data: BlobDeleteData): Promise<string | null> {
    const trx = this.db.db;
    const blob = await trx
      .selectFrom("blobs")
      .select(["status", "object_key"])
      .where("id", "=", data.blobId)
      .where("org_id", "=", data.orgId)
      .forUpdate()
      .executeTakeFirst();
    if (blob?.status !== "deleting") return null;
    const file = await trx
      .selectFrom("files")
      .select("id")
      .where("org_id", "=", data.orgId)
      .where("blob_id", "=", data.blobId)
      .limit(1)
      .executeTakeFirst();
    const share = await trx
      .selectFrom("file_shares")
      .select("id")
      .where("org_id", "=", data.orgId)
      .where("blob_id", "=", data.blobId)
      .limit(1)
      .executeTakeFirst();
    if (file || share) {
      this.log.warn("a blob marked for deletion is still referenced; keeping it", { ...data });
      return null;
    }
    return blob.object_key;
  }

  /** The last step of {@link deleteBlob}: the row, while it is still `deleting`. */
  @Transactional()
  async dropRow(data: BlobDeleteData): Promise<void> {
    await this.db.db
      .deleteFrom("blobs")
      .where("id", "=", data.blobId)
      .where("org_id", "=", data.orgId)
      .where("status", "=", "deleting")
      .execute();
  }
}

/** {@link BlobObjects} for the maintenance worker (storage and the database only). */
@Module({ imports: [StorageModule], providers: [BlobObjects], exports: [BlobObjects] })
export class BlobObjectsModule {}
