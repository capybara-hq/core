import { randomUUID } from "node:crypto";
import type { ObjectHead } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { BlobStatus } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { StorageService } from "../storage/storage.service.js";
import { blobObjectKey, deferred, oweBlobDelete } from "./blob-objects.js";

export { blobObjectKey, stagingObjectKey } from "./blob-objects.js";

/** A blob: bytes stored once per org (file library spec §1). */
export interface BlobRow {
  id: string;
  orgId: string;
  /** Hex sha256; null while `pending`, and for a migrated blob not hashed yet. */
  sha256: string | null;
  size: number;
  /** The etag the store reported for the kernel's own write (null: none; size only). */
  etag: string | null;
  /** Relative to the org's kernel prefix. */
  objectKey: string;
  status: BlobStatus;
}

/** What a read of a blob needs (the recorded facts it is checked against). */
export type BlobRef = Pick<BlobRow, "id" | "objectKey" | "size" | "etag">;

/**
 * The longest a kernel put of blob bytes may take (ms): well under the hour after which the blob
 * sweep treats a `pending` blob with no file as abandoned.
 */
const PUT_TIMEOUT_MS = 10 * 60_000;

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
 * The lock of one hash in one org (decision R9: one provider per transaction-scoped lock):
 * serializes the step that decides which blob holds a sha256 ({@link BlobsService.settle}), so two
 * writes of the same bytes never race on the `(org_id, sha256)` unique index. Joins the caller's
 * transaction, which holds it until it ends.
 */
@Injectable()
export class BlobHashLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(orgId: string, sha256: string): Promise<void> {
    await this.xactLock.lock(`capybara.blob-hash:${orgId}:${sha256}`);
  }
}

/**
 * The bytes of the file library (file library spec §1, §3 with its builder amendment, §4): per-org
 * blobs keyed by sha256, every one written by the kernel itself to `blobs/<blobId>`.
 *
 * - {@link writeIntent} commits a `pending` blob (no hash yet) before the kernel puts verified
 *   bytes at its key, so a crash leaves a row the sweep finds.
 * - {@link settle}, in the caller's transaction under the hash's lock, decides which blob holds
 *   the hash: an existing `ready` one (the new copy becomes `deleting`, its deletion owed) or the
 *   new one (`ready`, with the hash). An upload and a delivery do the same work either way.
 * - {@link lockReady} is the one gate for a new reference: every transaction that inserts or moves
 *   a reference to a blob (a file row, a share, a repoint) calls it first, so a blob a deletion
 *   claims is never pointed at again (`BlobObjects.deleteBlob`).
 * - Reads ({@link open}, {@link head}) check size and etag against the row.
 *
 * No upload form can write a blob's key, so no read depends on who uploaded what. No process state.
 */
@Injectable()
export class BlobsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(BlobHashLock) private readonly hashLock: Pick<BlobHashLock, "lock">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Bytes the kernel holds (a delivery): a `ready` blob of this hash in the org is returned as it
   * is (every ready blob was written or checked by the kernel); else the bytes are written to a new
   * blob ({@link writeIntent}, the put) and {@link settle}d in a transaction of their own. The
   * returned blob is not locked: a caller that then references it must call {@link lockReady} in
   * the transaction that inserts the reference and, on null (claimed by a deletion meanwhile), call
   * this again.
   */
  async ensureFromBytes(
    orgId: string,
    sha256: string,
    bytes: Uint8Array,
    opts: { contentType: string; signal?: AbortSignal },
  ): Promise<BlobRow> {
    const existing = await this.db
      .selectFrom("blobs")
      .select(BLOB_COLUMNS)
      .where("org_id", "=", orgId)
      .where("sha256", "=", sha256)
      .where("status", "=", "ready")
      .executeTakeFirst();
    if (existing) return toBlob(existing);
    const own = await this.writeVerified(orgId, bytes, opts);
    return this.settleAlone(orgId, own.id, sha256);
  }

  /** {@link settle} in a transaction of its own, never the caller's. */
  @Transactional({ propagation: "requires_new" })
  private async settleAlone(orgId: string, blobId: string, sha256: string): Promise<BlobRow> {
    return this.settle(orgId, blobId, sha256);
  }

  /**
   * Writes bytes the kernel verified to a new blob: the `pending` row first, committed on its own
   * (the intent), then the put at `blobs/<blobId>`; the row records the stored size and the etag
   * the store reported. Returns the still `pending` blob for {@link settle}. A failed put throws
   * and leaves the row for the sweep (`pending` with no file).
   */
  async writeVerified(
    orgId: string,
    bytes: Uint8Array,
    opts: { contentType: string; signal?: AbortSignal },
  ): Promise<BlobRow> {
    const intent = await this.writeIntent(orgId, bytes.byteLength);
    const timeout = AbortSignal.timeout(PUT_TIMEOUT_MS);
    const head = await this.storage.kernel(orgId).put(intent.objectKey, bytes, {
      contentType: opts.contentType || "application/octet-stream",
      size: bytes.byteLength,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    });
    return this.recordStored(orgId, intent.id, head.size, head.etag ?? null);
  }

  /** The `pending` intent of {@link writeVerified}, committed before the put. */
  @Transactional({ propagation: "requires_new" })
  async writeIntent(orgId: string, size: number): Promise<BlobRow> {
    const id = randomUUID();
    const row = await this.db.db
      .insertInto("blobs")
      .values({
        id,
        org_id: orgId,
        sha256: null,
        size,
        etag: null,
        object_key: blobObjectKey(id),
        status: "pending",
      })
      .returning(BLOB_COLUMNS)
      .executeTakeFirstOrThrow();
    return toBlob(row);
  }

  /** The stored size and etag of a `pending` blob after its put. */
  @Transactional()
  private async recordStored(
    orgId: string,
    id: string,
    size: number,
    etag: string | null,
  ): Promise<BlobRow> {
    const row = await this.db.db
      .updateTable("blobs")
      .set({ size, etag })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("status", "=", "pending")
      .returning(BLOB_COLUMNS)
      .executeTakeFirst();
    if (!row) throw new Error(`blob ${id} is no longer pending`);
    return toBlob(row);
  }

  /**
   * Decides, in the caller's transaction and under the hash's lock, which blob holds `sha256` for
   * the `pending` blob `blobId` the kernel just wrote: an existing `ready` blob of that hash is
   * locked ({@link lockReady}) and returned, and the new blob becomes `deleting` with its deletion
   * owed; otherwise the new blob becomes `ready` with the hash. A blob of that hash that is no longer
   * `ready` (being deleted, gone) gives the hash up first. The caller points its reference at the
   * returned blob in the same transaction.
   */
  @Transactional({ propagation: "mandatory" })
  async settle(orgId: string, blobId: string, sha256: string): Promise<BlobRow> {
    const trx = this.db.db;
    await this.hashLock.lock(orgId, sha256);
    const holder = await trx
      .selectFrom("blobs")
      .select("id")
      .where("org_id", "=", orgId)
      .where("sha256", "=", sha256)
      .where("status", "=", "ready")
      .executeTakeFirst();
    const existing = holder ? await this.lockReady(orgId, holder.id) : null;
    if (existing) {
      await trx
        .updateTable("blobs")
        .set({ status: "deleting" })
        .where("id", "=", blobId)
        .where("org_id", "=", orgId)
        .where("status", "=", "pending")
        .execute();
      // deferred: never due within the caller's request (no fast path runs while it waits)
      await oweBlobDelete(this.outbox, orgId, blobId, deferred());
      return existing;
    }
    await trx
      .updateTable("blobs")
      .set({ sha256: null })
      .where("org_id", "=", orgId)
      .where("sha256", "=", sha256)
      .where("status", "<>", "ready")
      .execute();
    const own = await trx
      .updateTable("blobs")
      .set({ status: "ready", sha256 })
      .where("id", "=", blobId)
      .where("org_id", "=", orgId)
      .where("status", "=", "pending")
      .returning(BLOB_COLUMNS)
      .executeTakeFirst();
    if (!own) throw new Error(`blob ${blobId} is no longer pending`);
    return toBlob(own);
  }

  /**
   * The gate of every new reference to a blob, in the caller's transaction: locks the blob row
   * `FOR SHARE` and returns it only while it is `ready` (else null: being deleted, gone, pending or
   * not in the org). A deletion claims the row `FOR UPDATE`, so it either waits for the caller's
   * reference (and then sees it) or has already made the blob `deleting` (and this refuses it).
   */
  @Transactional({ propagation: "mandatory" })
  async lockReady(orgId: string, blobId: string): Promise<BlobRow | null> {
    const row = await this.db.db
      .selectFrom("blobs")
      .select(BLOB_COLUMNS)
      .where("id", "=", blobId)
      .where("org_id", "=", orgId)
      .where("status", "=", "ready")
      .forShare()
      .executeTakeFirst();
    return row ? toBlob(row) : null;
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
