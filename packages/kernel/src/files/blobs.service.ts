import { randomUUID } from "node:crypto";
import type { ObjectHead } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { BlobStatus } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { StorageService } from "../storage/storage.service.js";
import {
  afterUploadForm,
  blobObjectKey,
  FILE_UPLOAD_TTL_SECONDS,
  oweStagingDelete,
} from "./blob-objects.js";

export { blobObjectKey, stagingObjectKey } from "./blob-objects.js";

/** A blob: bytes stored once per org (file library spec §1). */
export interface BlobRow {
  id: string;
  orgId: string;
  /** Hex sha256; null only for a blob not hashed yet (migrated, or adopted while contested). */
  sha256: string | null;
  size: number;
  /** The etag recorded when the bytes were checked (null: none recorded, size only). */
  etag: string | null;
  /** Relative to the org's kernel prefix. */
  objectKey: string;
  status: BlobStatus;
}

/** What a read of a blob needs (the recorded facts it is checked against). */
export type BlobRef = Pick<BlobRow, "id" | "objectKey" | "size" | "etag">;

/** What {@link BlobsService.resolveUpload} learned from the staging object at finalize. */
export interface VerifiedUpload {
  /** The sha256 finalize computed over the whole staging object. */
  sha256: string;
  size: number;
  /** The etag of the staging object finalize read (null: the store reported none). */
  etag: string | null;
  /** The staging object's key (`uploads/<fileId>`, or a migrated upload's `staging_key`). */
  stagingKey: string;
  /** The file row's `created_at` (when its upload form was made). */
  createdAt: Date;
}

type BlobDbRow = {
  id: string;
  org_id: string;
  sha256: string | null;
  size: string | number;
  etag: string | null;
  object_key: string;
  status: BlobStatus;
};

const BLOB_COLUMNS = ["id", "org_id", "sha256", "size", "etag", "object_key", "status"] as const;

const toBlob = (r: BlobDbRow): BlobRow => ({
  id: r.id,
  orgId: r.org_id,
  sha256: r.sha256,
  size: Number(r.size),
  etag: r.etag,
  objectKey: r.object_key,
  status: r.status,
});

/**
 * Whether a stored object is still the blob's recorded bytes: the same size, and the same etag
 * when one was recorded (migrated blobs have none: size only). Anything else is treated as gone.
 */
export function blobContentMatches(
  recorded: { size: number; etag: string | null },
  head: { size: number; etag?: string | undefined },
): boolean {
  return head.size === recorded.size && (recorded.etag === null || recorded.etag === head.etag);
}

/**
 * The bytes of the file library (file library spec §1, §3, §4): per-org blobs keyed by sha256.
 *
 * - Kernel-written bytes ({@link ensureFromBytes}) reuse any `ready` blob of the same hash (the
 *   kernel wrote or verified those bytes itself), else write `blobs/<sha256>` intent first.
 * - A finalized upload ({@link resolveUpload}) points at an existing blob only when that cannot
 *   tell its uploader anything about other accounts and cannot hand them bytes an upload form may
 *   still overwrite: the blob is `ready` and either its `dedup_after` has passed or the uploader's
 *   own file adopted it. Otherwise the upload's staging object becomes a blob of its own.
 * - Reads ({@link open}, {@link head}) check size and etag against the row.
 *
 * Only `ready` blobs are ever reused, and a reuse locks the row `FOR SHARE`, so a blob a deletion
 * claims (`FOR UPDATE`, then `deleting`) is never pointed at again. No process state.
 */
@Injectable()
export class BlobsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Bytes the kernel holds (a delivery): a `ready` blob of this hash in the org is returned as it
   * is (any `dedup_after`); else a `pending` row is committed on its own (the intent), the bytes
   * are put at `blobs/<sha256>`, and the row becomes `ready` with the stored size and etag. A
   * concurrent writer of the same hash writes the same bytes to the same key, so a `pending` row of
   * another writer is completed the same way. A blob of this hash being deleted makes the call
   * fail (retryable: the deletion removes the row shortly).
   */
  async ensureFromBytes(
    orgId: string,
    sha256: string,
    bytes: Uint8Array,
    opts: { contentType: string; signal?: AbortSignal },
  ): Promise<BlobRow> {
    const existing = await this.bySha(orgId, sha256);
    if (existing?.status === "ready") return existing;
    if (existing && existing.status !== "pending") {
      throw new Error(`blob ${existing.id} of this content is being deleted; try again`);
    }
    const intent = existing ?? (await this.insertIntent(orgId, sha256, bytes.byteLength));
    if (intent.status === "ready") return intent;
    if (intent.status !== "pending") {
      throw new Error(`blob ${intent.id} of this content is being deleted; try again`);
    }
    const head = await this.storage.kernel(orgId).put(intent.objectKey, bytes, {
      contentType: opts.contentType || "application/octet-stream",
      size: bytes.byteLength,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    return this.markReady(orgId, intent.id, head.size, head.etag ?? null);
  }

  /** The `pending` intent of {@link ensureFromBytes}, committed before the put. */
  @Transactional({ propagation: "requires_new" })
  private async insertIntent(orgId: string, sha256: string, size: number): Promise<BlobRow> {
    await this.db.db
      .insertInto("blobs")
      .values({
        id: randomUUID(),
        org_id: orgId,
        sha256,
        size,
        etag: null,
        object_key: blobObjectKey(sha256),
        status: "pending",
      })
      .onConflict((oc) =>
        oc.columns(["org_id", "sha256"]).where("sha256", "is not", null).doNothing(),
      )
      .execute();
    const row = await this.bySha(orgId, sha256);
    if (!row) throw new Error(`blob intent for ${sha256} not found after insert`);
    return row;
  }

  /** The last step of {@link ensureFromBytes}: `ready` with the stored size and etag. */
  @Transactional()
  private async markReady(
    orgId: string,
    id: string,
    size: number,
    etag: string | null,
  ): Promise<BlobRow> {
    await this.db.db
      .updateTable("blobs")
      .set({ status: "ready", size, etag })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "pending")
      .execute();
    const row = await this.db.db
      .selectFrom("blobs")
      .select(BLOB_COLUMNS)
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (row?.status !== "ready") throw new Error(`blob ${id} did not become ready`);
    return toBlob(row);
  }

  /**
   * Finalize's blob for a verified upload of `accountId`'s file `fileId`, in the caller's
   * transaction (which holds the file row):
   *
   * 1. a `ready` blob of this hash whose `dedup_after` has passed, or that one of the uploader's
   *    own files adopted, is reused; the staging object's deletion is owed (after its form
   *    expired);
   * 2. else a new blob adopts the staging object (`dedup_after` = now + the form's lifetime),
   *    inserted `ON CONFLICT (org_id, sha256) DO NOTHING`; a concurrent winner is reused under the
   *    rule of step 1;
   * 3. else (a contested hash: a winner another account's form may still overwrite, or one not
   *    `ready`) the staging object becomes a blob of its own with `sha256` null, for the hashing
   *    job to merge once the winner may be shared.
   *
   * The caller's answer is the same in every branch.
   */
  @Transactional({ propagation: "mandatory" })
  async resolveUpload(
    orgId: string,
    accountId: string,
    fileId: string,
    v: VerifiedUpload,
  ): Promise<{ blob: BlobRow; adopted: boolean }> {
    const reused = await this.reusable(orgId, accountId, v.sha256);
    if (reused) {
      await oweStagingDelete(
        this.outbox,
        orgId,
        fileId,
        v.stagingKey,
        afterUploadForm(v.createdAt),
      );
      return { blob: reused, adopted: false };
    }
    const id = randomUUID();
    const dedupAfter = sql<Date>`now() + make_interval(secs => ${FILE_UPLOAD_TTL_SECONDS})`;
    const inserted = await this.db.db
      .insertInto("blobs")
      .values({
        id,
        org_id: orgId,
        sha256: v.sha256,
        size: v.size,
        etag: v.etag,
        object_key: v.stagingKey,
        status: "ready",
        dedup_after: dedupAfter,
      })
      .onConflict((oc) =>
        oc.columns(["org_id", "sha256"]).where("sha256", "is not", null).doNothing(),
      )
      .returning(BLOB_COLUMNS)
      .executeTakeFirst();
    if (inserted) return { blob: toBlob(inserted), adopted: true };
    // a concurrent finalize of the same bytes won the hash
    const winner = await this.reusable(orgId, accountId, v.sha256);
    if (winner) {
      await oweStagingDelete(
        this.outbox,
        orgId,
        fileId,
        v.stagingKey,
        afterUploadForm(v.createdAt),
      );
      return { blob: winner, adopted: false };
    }
    const own = await this.db.db
      .insertInto("blobs")
      .values({
        id,
        org_id: orgId,
        sha256: null,
        size: v.size,
        etag: v.etag,
        object_key: v.stagingKey,
        status: "ready",
        dedup_after: dedupAfter,
      })
      .returning(BLOB_COLUMNS)
      .executeTakeFirstOrThrow();
    return { blob: toBlob(own), adopted: true };
  }

  /**
   * The `ready` blob of this hash an upload of `accountId` may point at (step 1 of
   * {@link resolveUpload}), locked `FOR SHARE` so no deletion claims it before the caller commits.
   */
  private async reusable(
    orgId: string,
    accountId: string,
    sha256: string,
  ): Promise<BlobRow | undefined> {
    const row = await this.db.db
      .selectFrom("blobs")
      .select(BLOB_COLUMNS)
      .select(sql<boolean>`dedup_after <= now()`.as("shareable"))
      .where("org_id", "=", orgId)
      .where("sha256", "=", sha256)
      .where("status", "=", "ready")
      .forShare()
      .executeTakeFirst();
    if (!row) return undefined;
    if (row.shareable) return toBlob(row);
    // within its form's lifetime only the account whose upload it adopted may share it
    const own = await this.db.db
      .selectFrom("files")
      .select("id")
      .where("org_id", "=", orgId)
      .where("blob_id", "=", row.id)
      .where("account_id", "=", accountId)
      .where((eb) =>
        eb.or([
          eb("staging_key", "=", row.object_key),
          eb(sql<string>`'uploads/' || id`, "=", row.object_key),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    return own ? toBlob(row) : undefined;
  }

  /** The blob of this hash in the org, if any (any status). */
  private async bySha(orgId: string, sha256: string): Promise<BlobRow | undefined> {
    const row = await this.db.db
      .selectFrom("blobs")
      .select(BLOB_COLUMNS)
      .where("org_id", "=", orgId)
      .where("sha256", "=", sha256)
      .executeTakeFirst();
    return row ? toBlob(row) : undefined;
  }

  /**
   * Opens a blob's bytes (whole, or a range): null when certainly gone (the object missing, or its
   * size or etag not the recorded one: content replaced, logged as a warning). Every other error
   * (storage unavailable, network) throws. The caller reads or cancels `body`.
   */
  async open(
    orgId: string,
    blob: BlobRef,
    opts: { range?: { start: number; end?: number }; signal?: AbortSignal } = {},
  ): Promise<{ head: ObjectHead; body: ReadableStream<Uint8Array> } | null> {
    const got = await this.storage.kernel(orgId).get(blob.objectKey, {
      ...(opts.range !== undefined && { range: opts.range }),
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    if (!got) return null;
    if (!this.matches(orgId, blob, got.head)) {
      await got.body.cancel().catch(() => {});
      return null;
    }
    return got;
  }

  /** The blob object's head when it is still the recorded bytes; null when gone or replaced. */
  async head(orgId: string, blob: BlobRef): Promise<ObjectHead | null> {
    const head = await this.storage.kernel(orgId).head(blob.objectKey);
    if (!head) return null;
    return this.matches(orgId, blob, head) ? head : null;
  }

  /** {@link blobContentMatches}, logging a replaced object. */
  private matches(orgId: string, blob: BlobRef, head: ObjectHead): boolean {
    if (blobContentMatches(blob, head)) return true;
    this.log.warn("blob content changed after it was recorded; treating it as unavailable", {
      orgId,
      blobId: blob.id,
    });
    return false;
  }
}
