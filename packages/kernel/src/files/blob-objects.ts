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
 * Blob and staging objects of the file library (file library spec §1, §3), all relative to the
 * org's kernel prefix (`kernel/<orgId>/`): a blob the kernel wrote is `blobs/<sha256>`, an upload
 * stages at `uploads/<fileId>` (a migrated upload kept its old key in `files.staging_key`), and a
 * finalized upload's blob may adopt its staging object as it is. Deleting either kind is owed
 * through the outbox by the transaction that stops using it; the handlers re-read the rows first.
 */

/** The object key of a blob the kernel writes itself (deliveries), relative to the org prefix. */
export const blobObjectKey = (sha256: string): string => `blobs/${sha256}`;

/** The staging key a new upload is presigned to, relative to the org prefix. */
export const stagingObjectKey = (fileId: string): string => `uploads/${fileId}`;

/**
 * How long a presigned upload form stays valid (seconds). Short: within it the uploader can write
 * the staging object again, so a blob adopting it is offered to other accounts only once it has
 * passed (`blobs.dedup_after`), and reads check size and etag.
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
 * - A blob is deleted only while its row is `deleting` and no file or share points at it; then its
 *   object goes, then its row. A blob still referenced is left alone and logged: nothing turns a
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
    const blob = await this.db
      .selectFrom("blobs")
      .select(["status", "object_key"])
      .where("id", "=", data.blobId)
      .where("org_id", "=", data.orgId)
      .executeTakeFirst();
    if (blob?.status !== "deleting") return;
    if (await this.referenced(data)) {
      this.log.warn("a blob marked for deletion is still referenced; keeping it", { ...data });
      return;
    }
    await this.storage.kernel(data.orgId).delete(blob.object_key);
    await this.dropRow(data);
  }

  /** Whether any file or share row points at the blob. */
  private async referenced(data: BlobDeleteData): Promise<boolean> {
    const file = await this.db
      .selectFrom("files")
      .select("id")
      .where("org_id", "=", data.orgId)
      .where("blob_id", "=", data.blobId)
      .limit(1)
      .executeTakeFirst();
    if (file) return true;
    const share = await this.db
      .selectFrom("file_shares")
      .select("id")
      .where("org_id", "=", data.orgId)
      .where("blob_id", "=", data.blobId)
      .limit(1)
      .executeTakeFirst();
    return share !== undefined;
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
