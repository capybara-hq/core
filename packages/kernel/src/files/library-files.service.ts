import { createHash, randomUUID } from "node:crypto";
import { MEDIA_LIMITS, type ObjectStore, type PresignedUpload } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  countPdfPages,
  normalizeContentType,
  sniffMatches,
} from "../conversations/attachments.service.js";
import { EventLog } from "../conversations/event-log.js";
import type { LogContentBlock } from "../conversations/events.js";
import { isImageContentType, isMediaContentType } from "../conversations/media-types.js";
import type { FileStatus } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { revokeSharesIn } from "../shares/revoke.js";
import { StorageService } from "../storage/storage.service.js";
import {
  afterUploadForm,
  deferred,
  FILE_UPLOAD_TTL_SECONDS,
  oweBlobDelete,
  oweFileRelease,
  oweStagingDelete,
  stagingObjectKey,
} from "./blob-objects.js";
import { BlobsService } from "./blobs.service.js";

export type { FileOrigin, FileStatus } from "../db/kernel-schema.js";

/** Unfinished uploads (`uploading` + `draft`) one account may have in an org. */
export const MAX_PENDING_FILES = 50;
/** Expired uploads and drafts one cleanup batch takes. */
const CLEANUP_BATCH = 100;
/** How many leading bytes finalize checks against the declared type's signature. */
const SNIFF_BYTES = 1024;
/** How often {@link LibraryFilesService.addFromBytes} ensures a blob a deletion claimed. */
const ADD_BLOB_ATTEMPTS = 3;

/**
 * {@link LibraryFilesService.addFromBytes} found the blob of these bytes claimed by a deletion
 * {@link ADD_BLOB_ATTEMPTS} times in a row (nothing written): a transient race, worth a retry.
 */
export class FileBlobClaimedError extends Error {
  constructor() {
    super("the stored bytes were being deleted while the file was added");
    this.name = "FileBlobClaimedError";
  }
}

/** Where an upload is made: the composer (a draft until sent) or the Files page (ready at once). */
export type UploadPurpose = "composer" | "library";

/** A file as the upload routes answer it. */
export interface FileView {
  id: string;
  name: string;
  contentType: string;
  size: number;
  status: Exclude<FileStatus, "deleted">;
}

/**
 * `POST /files`: `upload` is the presigned form to send the bytes with (then finalize), or null
 * when the caller already holds these bytes in one of their own files (the file is created at
 * once; nothing to upload or finalize). `expiresAt`: the form's expiry, null without a form.
 */
export interface CreatedFile {
  file: FileView;
  upload: PresignedUpload | null;
  expiresAt: string | null;
}

/** The upload limits (`GET /files/limits`): the web's pre-checks. */
export interface FileLimits {
  /** The accepted content types. */
  types: string[];
  /** The accepted extensions next to `types` (lower case, no dot). */
  extensions: string[];
  /** The size limit of a file that is not an image (bytes). */
  maxBytes: number;
  /** The size limit of an image (bytes; also bound by `MEDIA_LIMITS.imageBytes`). */
  imageMaxBytes: number;
  /** Files per message. */
  maxPerMessage: number;
  /** The media budget of one model request (raw bytes). */
  requestMediaBytes: number;
  /** Whether the deployment has an object store; uploads are unavailable without one. */
  available: boolean;
}

/** A logged image block (the narrowed media type the log carries). */
type ImageBlock = Extract<LogContentBlock, { type: "image" }>;
/** A logged document block. */
type DocumentBlock = Extract<LogContentBlock, { type: "document" }>;

/**
 * The content block a message carries for a file (a `ref` to its id, never bytes): images, PDFs
 * and text become blocks the model reads itself; every other accepted type a `file` block the
 * model only gets a reference to.
 */
export function fileContentBlock(f: {
  id: string;
  name: string;
  contentType: string;
  size: number;
}): LogContentBlock {
  const source = { kind: "ref" as const, fileId: f.id };
  if (isImageContentType(f.contentType)) {
    return {
      type: "image",
      mediaType: f.contentType as ImageBlock["mediaType"],
      source,
      name: f.name,
      size: f.size,
    };
  }
  if (isMediaContentType(f.contentType)) {
    return {
      type: "document",
      mediaType: f.contentType as DocumentBlock["mediaType"],
      source,
      name: f.name,
      size: f.size,
    };
  }
  return { type: "file", mediaType: f.contentType, source, name: f.name, size: f.size };
}

const notFound = () => new ApiError("file.not_found", "File not found");

/** The file row columns the upload paths read. */
type UploadRow = {
  id: string;
  name: string;
  content_type: string;
  size: string | number;
  status: FileStatus;
  blob_id: string | null;
  staging_key: string | null;
  sha256: string | null;
  upload_purpose: UploadPurpose | null;
  created_at: Date;
};

const UPLOAD_COLUMNS = [
  "id",
  "name",
  "content_type",
  "size",
  "status",
  "blob_id",
  "staging_key",
  "sha256",
  "upload_purpose",
  "created_at",
] as const;

const viewOf = (r: Pick<UploadRow, "id" | "name" | "content_type" | "size" | "status">) => {
  if (r.status === "deleted") throw notFound();
  return {
    id: r.id,
    name: r.name,
    contentType: r.content_type,
    size: Number(r.size),
    status: r.status,
  } satisfies FileView;
};

/** What finalize read from the staging object. */
interface ReadUpload {
  bytes: Uint8Array;
  sha256: string;
  pages: number | null;
  sniffed: boolean;
}

/** How long finalize waits for the staging object's bytes before giving up (ms). */
const READ_TIMEOUT_MS = 60_000;
/** Finalizes one replica reads and copies at once (each holds up to one upload in memory). */
const FINALIZE_SLOTS = 4;

/**
 * A process-local counting semaphore. It bounds this replica's memory and bandwidth only: it is a
 * resource limit, not shared state (no answer depends on it, and each replica has its own), so it
 * does not break the rule that cross-request state lives in PG or Redis.
 */
class LocalSlots {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.free = size;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  }
}

/**
 * The files of the file library (file library spec §2–§4 with the builder amendment of §3):
 * account-owned rows over blobs.
 *
 * Uploading: `create` admits the upload and, unless the caller already holds the same bytes in a
 * file of their own, inserts an `uploading` row (with the declared sha256 and the purpose) before
 * presigning `uploads/<fileId>`. `finalize` checks the staging object (size, type, signature, PDF
 * pages), reads it whole, compares its sha256 with the declared one, copies the verified bytes to a
 * kernel-owned blob (`blobs/<blobId>`, intent first) and settles that blob in one transaction
 * ({@link BlobsService.settle}); the staging object's deletion is always owed. No form can write a
 * blob's key, and every branch does the same work, so nothing the caller can observe depends on
 * whether another account stored the same bytes. `discard` drops a composer upload before it is
 * sent; expired uploads and drafts go with {@link expireBatch}.
 *
 * Sending: {@link attachForMessage} turns the sender's drafts into `ready` files and records the
 * conversation's reference, in the message's transaction. No process state.
 */
@Injectable()
export class LibraryFilesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService)
    private readonly storage: Pick<StorageService, "available" | "assertAvailable" | "kernel">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(BlobsService)
    private readonly blobs: Pick<
      BlobsService,
      "writeVerified" | "settle" | "lockReady" | "ensureFromBytes"
    >,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    /** The `files` change of the conversations that referred to a deleted file. */
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "publishChanged">,
  ) {}

  /** This replica's bound on finalizes reading and copying at once ({@link LocalSlots}). */
  private readonly finalizeSlots = new LocalSlots(FINALIZE_SLOTS);

  /** The upload limits under the current config (needs no object store). */
  limits(): FileLimits {
    const cfg = this.config.get().attachments;
    return {
      types: [...cfg.allowedTypes],
      extensions: [...cfg.allowedExtensions],
      maxBytes: Math.min(cfg.maxBytes, MEDIA_LIMITS.documentBytes),
      imageMaxBytes: Math.min(cfg.maxBytes, MEDIA_LIMITS.imageBytes),
      maxPerMessage: cfg.maxPerMessage,
      requestMediaBytes: cfg.requestMediaBytes,
      available: this.storage.available,
    };
  }

  /** One file's size limit: the configured `maxBytes`, an image also `MEDIA_LIMITS.imageBytes`. */
  limitFor(contentType: string): number {
    return Math.min(
      this.config.get().attachments.maxBytes,
      isImageContentType(contentType) ? MEDIA_LIMITS.imageBytes : MEDIA_LIMITS.documentBytes,
    );
  }

  /**
   * Starts an upload. Admission: a type outside `attachments.allowedTypes` →
   * `file.type_not_allowed`; over the size limit → `file.too_large`; {@link MAX_PENDING_FILES}
   * unfinished files (`uploading` + `draft`) of the account in the org → `file.too_many_pending`
   * (a soft cap); no object store → `storage.unavailable`.
   *
   * When one of the caller's own `ready` or unexpired `draft` files of the same type and size has
   * this sha256 and a `ready` blob, the new file is created on that blob at once (`upload: null`):
   * the caller already holds those bytes, so nothing is learned. In every other case (another
   * account's bytes included) an `uploading` row is inserted with the declared sha256 and purpose
   * (expiring after `attachments.unboundTtlHours`) before a form for `uploads/<fileId>` is
   * presigned, the store enforcing the declared size and type.
   */
  async create(
    orgId: string,
    accountId: string,
    input: {
      name: string;
      contentType: string;
      size: number;
      sha256: string;
      purpose: UploadPurpose;
    },
  ): Promise<CreatedFile> {
    this.storage.assertAvailable();
    const contentType = await this.admit(orgId, accountId, input);
    const instant = await this.createOnOwnBlob(orgId, accountId, { ...input, contentType });
    if (instant) return { file: instant, upload: null, expiresAt: null };
    const id = randomUUID();
    const ttlHours = this.config.get().attachments.unboundTtlHours;
    await this.db
      .insertInto("files")
      .values({
        id,
        org_id: orgId,
        account_id: accountId,
        blob_id: null,
        name: input.name,
        content_type: contentType,
        size: input.size,
        origin: "upload",
        status: "uploading",
        sha256: input.sha256,
        upload_purpose: input.purpose,
        expires_at: sql<Date>`now() + make_interval(hours => ${ttlHours})`,
      })
      .execute();
    const upload = await this.storage.kernel(orgId).presignPut(stagingObjectKey(id), {
      contentType,
      maxSize: input.size,
      ttlSeconds: FILE_UPLOAD_TTL_SECONDS,
    });
    return {
      file: { id, name: input.name, contentType, size: input.size, status: "uploading" },
      upload,
      expiresAt: new Date(Date.now() + FILE_UPLOAD_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** The admission checks of {@link create}; returns the normalized content type. */
  private async admit(
    orgId: string,
    accountId: string,
    input: { contentType: string; size: number },
  ): Promise<string> {
    const contentType = this.admitType(input);
    const pending = await this.db
      .selectFrom("files")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("status", "in", ["uploading", "draft"])
      .executeTakeFirst();
    if (Number(pending?.n ?? 0) >= MAX_PENDING_FILES) {
      throw new ApiError(
        "file.too_many_pending",
        `Too many unfinished uploads (at most ${MAX_PENDING_FILES}); send, remove or wait for them first`,
      );
    }
    return contentType;
  }

  /** The type and size checks of an upload; returns the normalized content type. */
  private admitType(input: { contentType: string; size: number }): string {
    const contentType = normalizeContentType(input.contentType);
    if (!this.config.get().attachments.allowedTypes.includes(contentType)) {
      throw new ApiError(
        "file.type_not_allowed",
        `File type ${JSON.stringify(contentType)} is not allowed`,
      );
    }
    const limit = this.limitFor(contentType);
    if (input.size > limit) {
      throw new ApiError(
        "file.too_large",
        `File is ${input.size} bytes, over the limit of ${limit} bytes`,
      );
    }
    return contentType;
  }

  /**
   * The owner of a library file of the org that is not deleted, or null (no such file: a `read`
   * copy, another org's id). A file has one owner (file library spec §2).
   */
  async ownerOf(orgId: string, fileId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("files")
      .select("account_id")
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .where("status", "<>", "deleted")
      .executeTakeFirst();
    return row?.account_id ?? null;
  }

  /**
   * Adds bytes the kernel already holds (a conversation file the `Platform` tool resolved, never
   * another account's library file: the caller refuses those) to the account's library as an
   * upload, `ready` at once.
   *
   * - `referencedId` already one of the account's `ready` files: returned as it is
   *   (`existing: true`), or, with a `rename` other than its name, a new entry on its blob.
   * - Otherwise: no object store → `storage.unavailable`, the upload's type and size checks, the
   *   signature check of finalize (`file.type_not_allowed`); the account's own `ready` file of the
   *   same name, type and sha256 is returned as it is (`existing: true`; a repeated call adds
   *   nothing). Else the bytes go through {@link BlobsService.ensureFromBytes} (the org's ready
   *   blob of this hash, else a new one written intent first and settled) and the file row is
   *   inserted on it behind {@link BlobsService.lockReady}; a blob a deletion claimed meanwhile is
   *   ensured again, and {@link FileBlobClaimedError} is thrown after
   *   {@link ADD_BLOB_ATTEMPTS} tries. No presigned form is involved.
   */
  async addFromBytes(
    orgId: string,
    accountId: string,
    input: {
      /** The id the bytes were referenced by. */
      referencedId?: string;
      /** The referenced file's name. */
      name: string;
      /** The name the new entry takes instead of {@link name}. */
      rename?: string;
      contentType: string;
      bytes: Uint8Array;
      sha256: string;
      signal?: AbortSignal;
    },
  ): Promise<FileView & { existing: boolean }> {
    const name = input.rename ?? input.name;
    if (input.referencedId !== undefined) {
      const own = await this.db
        .selectFrom("files")
        .select(["id", "name", "content_type", "size", "status", "blob_id", "sha256", "pages"])
        .where("id", "=", input.referencedId)
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .where("status", "=", "ready")
        .executeTakeFirst();
      if (own && (input.rename === undefined || input.rename === own.name)) {
        return { ...viewOf(own), existing: true };
      }
      if (own?.blob_id) {
        // a renamed copy of the account's own file: a new entry on the same blob, as `create`
        // does for bytes the caller already holds
        const copy = await this.insertReady(orgId, accountId, own.blob_id, {
          name,
          contentType: own.content_type,
          size: Number(own.size),
          sha256: own.sha256 ?? input.sha256,
          pages: own.pages,
        });
        if (copy !== null) return { ...copy, existing: false };
      }
    }
    this.storage.assertAvailable();
    const size = input.bytes.byteLength;
    const contentType = this.admitType({ contentType: input.contentType, size });
    if (!sniffMatches(contentType, input.bytes.subarray(0, SNIFF_BYTES))) {
      throw new ApiError("file.type_not_allowed", `File content is not ${contentType}`);
    }
    // two concurrent calls may both miss this and insert one entry each: benign, both are valid
    // files of the account on the same blob (the person may delete one); no lock is worth it
    const same = await this.db
      .selectFrom("files")
      .select(["id", "name", "content_type", "size", "status"])
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("status", "=", "ready")
      .where("sha256", "=", input.sha256)
      .where("content_type", "=", contentType)
      .where("name", "=", name)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (same) return { ...viewOf(same), existing: true };
    const pages = contentType === "application/pdf" ? countPdfPages(input.bytes) || null : null;
    for (let attempt = 1; attempt <= ADD_BLOB_ATTEMPTS; attempt++) {
      const blob = await this.blobs.ensureFromBytes(orgId, input.sha256, input.bytes, {
        contentType,
        ...(input.signal !== undefined && { signal: input.signal }),
      });
      const added = await this.insertReady(orgId, accountId, blob.id, {
        name,
        contentType,
        size,
        sha256: input.sha256,
        pages,
      });
      if (added !== null) return { ...added, existing: false };
    }
    throw new FileBlobClaimedError();
  }

  /**
   * The transaction of {@link addFromBytes}: the blob locked ready, then a `ready` upload file of
   * the account on it. Null when a deletion claimed the blob (nothing written).
   */
  @Transactional()
  private async insertReady(
    orgId: string,
    accountId: string,
    blobId: string,
    f: { name: string; contentType: string; size: number; sha256: string; pages: number | null },
  ): Promise<FileView | null> {
    const blob = await this.blobs.lockReady(orgId, blobId);
    if (!blob) return null;
    const id = randomUUID();
    await this.db.db
      .insertInto("files")
      .values({
        id,
        org_id: orgId,
        account_id: accountId,
        blob_id: blob.id,
        ref_key: blob.objectKey,
        ref_etag: blob.etag,
        name: f.name,
        content_type: f.contentType,
        size: f.size,
        pages: f.pages,
        origin: "upload",
        status: "ready",
        sha256: f.sha256,
        upload_purpose: "library",
        expires_at: null,
      })
      .execute();
    return { id, name: f.name, contentType: f.contentType, size: f.size, status: "ready" };
  }

  /**
   * The instant path of {@link create}: a new file on the blob of one of the caller's own files
   * with this sha256, or undefined. The blob passes {@link BlobsService.lockReady}, so a deletion
   * claiming it concurrently either waits for this file or makes the caller upload.
   */
  @Transactional()
  private async createOnOwnBlob(
    orgId: string,
    accountId: string,
    input: {
      name: string;
      contentType: string;
      size: number;
      sha256: string;
      purpose: UploadPurpose;
    },
  ): Promise<FileView | undefined> {
    const trx = this.db.db;
    const mine = await trx
      .selectFrom("files")
      .innerJoin("blobs", "blobs.id", "files.blob_id")
      .select(["files.blob_id", "files.pages"])
      .where("files.org_id", "=", orgId)
      .where("files.account_id", "=", accountId)
      .where("files.sha256", "=", input.sha256)
      .where("files.content_type", "=", input.contentType)
      .where("files.size", "=", String(input.size))
      .where((eb) =>
        eb.or([
          eb("files.status", "=", "ready"),
          eb.and([eb("files.status", "=", "draft"), eb("files.expires_at", ">", sql<Date>`now()`)]),
        ]),
      )
      .where("blobs.org_id", "=", orgId)
      .where("blobs.status", "=", "ready")
      .limit(1)
      .executeTakeFirst();
    if (!mine?.blob_id) return undefined;
    const blob = await this.blobs.lockReady(orgId, mine.blob_id);
    if (!blob) return undefined;
    const id = randomUUID();
    const draft = input.purpose === "composer";
    const ttlHours = this.config.get().attachments.unboundTtlHours;
    await trx
      .insertInto("files")
      .values({
        id,
        org_id: orgId,
        account_id: accountId,
        blob_id: blob.id,
        // the reference the model may see stays this blob's after a later merge
        ref_key: blob.objectKey,
        ref_etag: blob.etag,
        name: input.name,
        content_type: input.contentType,
        size: input.size,
        pages: mine.pages,
        origin: "upload",
        status: draft ? "draft" : "ready",
        sha256: input.sha256,
        upload_purpose: input.purpose,
        expires_at: draft ? sql<Date>`now() + make_interval(hours => ${ttlHours})` : null,
      })
      .execute();
    return {
      id,
      name: input.name,
      contentType: input.contentType,
      size: input.size,
      status: draft ? "draft" : "ready",
    };
  }

  /**
   * Finishes an upload (the uploader only; a file already `draft` or `ready` is answered as it
   * is; an expired upload is `file.not_found`):
   *
   * - the staging object missing, or smaller than declared → `file.not_ready` (upload again);
   * - larger than declared, a stored type or a signature that does not match →
   *   `file.type_not_allowed` / `file.too_large`, and the upload is rejected;
   * - the whole object is read; a sha256 other than the declared one → `file.hash_mismatch`, and
   *   the upload is rejected.
   *
   * A rejected upload expires at once and owes its staging object's deletion (no direct delete:
   * the outbox handler re-reads the row). Otherwise the verified bytes are copied to a new
   * kernel-owned blob (intent first) and one transaction, holding the file row, settles that blob
   * and makes the file `draft` (composer, expiring after `attachments.unboundTtlHours`) or `ready`
   * (library), owing the staging object's deletion. The same work runs whether or not the org held
   * these bytes already.
   */
  async finalize(orgId: string, accountId: string, fileId: string): Promise<FileView> {
    this.storage.assertAvailable();
    const row = await this.db
      .selectFrom("files")
      .select(UPLOAD_COLUMNS)
      .select(sql<boolean>`expires_at IS NOT NULL AND expires_at <= now()`.as("expired"))
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("origin", "=", "upload")
      .where("status", "in", ["uploading", "draft", "ready"])
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.status !== "uploading") return viewOf(row);
    if (row.expired) throw notFound();
    const size = Number(row.size);
    const key = row.staging_key ?? stagingObjectKey(row.id);
    const store = this.storage.kernel(orgId);
    const head = await store.head(key);
    if (!head || head.size < size) {
      throw new ApiError(
        "file.not_ready",
        head
          ? `Uploaded file is ${head.size} bytes, but ${size} bytes were declared; upload it again`
          : "The file has not been uploaded yet",
      );
    }
    if (head.size > size) {
      await this.reject(orgId, accountId, row);
      throw new ApiError("file.too_large", "Uploaded file is larger than declared");
    }
    if (normalizeContentType(head.contentType) !== row.content_type) {
      await this.reject(orgId, accountId, row);
      throw new ApiError("file.type_not_allowed", "Uploaded file type does not match");
    }
    return this.finalizeSlots.run(() => this.verifyAndCopy(orgId, accountId, row, key, size));
  }

  /**
   * The bounded part of {@link finalize}: reads the staging object, checks its signature and hash,
   * copies the verified bytes to a new blob and commits.
   */
  private async verifyAndCopy(
    orgId: string,
    accountId: string,
    row: UploadRow,
    key: string,
    size: number,
  ): Promise<FileView> {
    const store = this.storage.kernel(orgId);
    const read = await this.readUpload(store, key, row.content_type, size);
    if (!read) {
      throw new ApiError(
        "file.not_ready",
        "The uploaded file changed while it was checked; upload it again",
      );
    }
    if (!read.sniffed) {
      await this.reject(orgId, accountId, row);
      throw new ApiError(
        "file.type_not_allowed",
        `Uploaded file content is not ${row.content_type}`,
      );
    }
    // a migrated upload declared no hash: the computed one stands
    if (row.sha256 !== null && read.sha256 !== row.sha256) {
      await this.reject(orgId, accountId, row);
      throw new ApiError(
        "file.hash_mismatch",
        "The uploaded bytes do not match the declared sha256; upload the file again",
      );
    }
    const own = await this.blobs.writeVerified(orgId, read.bytes, {
      contentType: row.content_type,
    });
    const done = await this.commitFinalize(orgId, accountId, row, own.id, read);
    if (done === null) throw notFound();
    return done;
  }

  /**
   * Streams the whole staging object once (bounded by the declared size and a timeout): its bytes,
   * sha256, leading bytes' signature check and, for a PDF, its page count. Null when the object
   * vanished or is not the declared size.
   */
  private async readUpload(
    store: ObjectStore,
    key: string,
    contentType: string,
    size: number,
  ): Promise<ReadUpload | null> {
    const got = await store.get(key, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!got) return null;
    if (got.head.size !== size) {
      await got.body.cancel().catch(() => {});
      return null;
    }
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = got.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > size) {
        await reader.cancel().catch(() => {});
        return null;
      }
      hash.update(value);
      chunks.push(value);
    }
    if (total !== size) return null;
    const bytes = Buffer.concat(chunks, total);
    return {
      bytes,
      sha256: hash.digest("hex"),
      pages: contentType === "application/pdf" ? countPdfPages(bytes) || null : null,
      sniffed: sniffMatches(contentType, bytes.subarray(0, SNIFF_BYTES)),
    };
  }

  /**
   * A rejected upload: under the file row's lock, an upload still in progress expires now and its
   * staging object's deletion is owed (the cleanup job then drops the row).
   */
  @Transactional()
  private async reject(
    orgId: string,
    accountId: string,
    row: Pick<UploadRow, "id" | "staging_key" | "created_at">,
  ): Promise<void> {
    const trx = this.db.db;
    const locked = await trx
      .selectFrom("files")
      .select("status")
      .where("id", "=", row.id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
    if (locked?.status !== "uploading") return;
    await trx
      .updateTable("files")
      .set({ expires_at: sql<Date>`now()` })
      .where("id", "=", row.id)
      .where("org_id", "=", orgId)
      .execute();
    await oweStagingDelete(
      this.outbox,
      orgId,
      row.id,
      row.staging_key ?? stagingObjectKey(row.id),
      deferred(afterUploadForm(row.created_at)),
    );
  }

  /**
   * The transaction of {@link finalize}: the file row locked and still an unexpired upload, the new
   * blob settled ({@link BlobsService.settle}), the file pointed at the result and set `draft` /
   * `ready` with the verified hash, the staging object's deletion owed. When the file is no longer
   * an upload in progress (a concurrent finalize, a discard, the cleanup) the new blob is released
   * instead (`deleting`, its deletion owed); the answer is then the file as it is, or null when it
   * expired or is gone.
   */
  @Transactional()
  private async commitFinalize(
    orgId: string,
    accountId: string,
    row: Pick<UploadRow, "id" | "staging_key" | "upload_purpose" | "created_at">,
    blobId: string,
    read: Pick<ReadUpload, "sha256" | "pages">,
  ): Promise<FileView | null> {
    const trx = this.db.db;
    const locked = await trx
      .selectFrom("files")
      .select(UPLOAD_COLUMNS)
      .select(sql<boolean>`expires_at IS NOT NULL AND expires_at <= now()`.as("expired"))
      .where("id", "=", row.id)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
    if (locked?.status !== "uploading" || locked.expired) {
      await trx
        .updateTable("blobs")
        .set({ status: "deleting" })
        .where("id", "=", blobId)
        .where("org_id", "=", orgId)
        .where("status", "=", "pending")
        .execute();
      await oweBlobDelete(this.outbox, orgId, blobId, deferred());
      return locked && locked.status !== "uploading" && locked.status !== "deleted"
        ? viewOf(locked)
        : null;
    }
    const blob = await this.blobs.settle(orgId, blobId, read.sha256);
    const draft = (locked.upload_purpose ?? "composer") === "composer";
    const ttlHours = this.config.get().attachments.unboundTtlHours;
    await trx
      .updateTable("files")
      .set({
        blob_id: blob.id,
        ref_key: blob.objectKey,
        ref_etag: blob.etag,
        status: draft ? "draft" : "ready",
        sha256: read.sha256,
        pages: read.pages,
        expires_at: draft ? sql<Date>`now() + make_interval(hours => ${ttlHours})` : null,
      })
      .where("id", "=", row.id)
      .where("org_id", "=", orgId)
      .execute();
    await oweStagingDelete(
      this.outbox,
      orgId,
      row.id,
      locked.staging_key ?? stagingObjectKey(row.id),
      deferred(afterUploadForm(locked.created_at)),
    );
    return viewOf({ ...locked, status: draft ? "draft" : "ready" });
  }

  /**
   * A composer upload removed before it was sent (the uploader only; an `uploading` or `draft`
   * file no conversation refers to, else `file.not_found`): `deleted`, with the deferred release of
   * what it held owed (`file-release`, run by `BlobObjects.releaseFile`): the request does the same
   * work whatever else points at its blob.
   */
  @Transactional()
  async discard(orgId: string, accountId: string, fileId: string): Promise<void> {
    const trx = this.db.db;
    const row = await trx
      .selectFrom("files")
      .select(UPLOAD_COLUMNS)
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("status", "in", ["uploading", "draft"])
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    const referenced = await trx
      .selectFrom("conversation_files")
      .select("file_id")
      .where("org_id", "=", orgId)
      .where("file_id", "=", fileId)
      .limit(1)
      .executeTakeFirst();
    if (referenced) throw notFound();
    await trx
      .updateTable("files")
      .set({ status: "deleted", deleted_at: sql<Date>`now()`, expires_at: null })
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .execute();
    await oweFileRelease(this.outbox, orgId, fileId, deferred(afterUploadForm(row.created_at)));
  }

  /**
   * Expires one batch of the org's `uploading` / `draft` files past `expires_at` (`FOR UPDATE SKIP
   * LOCKED`, so concurrent runs never share a row): each becomes `deleted` with the deferred release
   * of what it held owed (`file-release`). Returns how many it took.
   */
  @Transactional()
  async expireBatch(orgId: string): Promise<number> {
    const trx = this.db.db;
    const rows = await trx
      .selectFrom("files")
      .select(UPLOAD_COLUMNS)
      .where("org_id", "=", orgId)
      .where("status", "in", ["uploading", "draft"])
      .where("expires_at", "<", sql<Date>`now()`)
      .orderBy("expires_at")
      .limit(CLEANUP_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return 0;
    await trx
      .updateTable("files")
      .set({ status: "deleted", deleted_at: sql<Date>`now()`, expires_at: null })
      .where("org_id", "=", orgId)
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
    for (const r of rows) {
      await oweFileRelease(this.outbox, orgId, r.id, deferred(afterUploadForm(r.created_at)));
    }
    return rows.length;
  }

  /**
   * The names of the files in `ids` the sender owns and has not deleted (composer inline tokens
   * spec §3.2: the labels a message's file tokens and uploads get), read-only and outside any
   * transaction. An id it does not return is refused by {@link attachForMessage} in the message's
   * transaction, with the codes it gives.
   */
  async labelsFor(
    orgId: string,
    accountId: string,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("files")
      .select(["id", "name"])
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("id", "in", [...new Set(ids)])
      .where("status", "!=", "deleted")
      .execute();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * Attaches the sender's files to a message, in the message's transaction (rows `FOR UPDATE`, in
   * id order). The caller has already checked that the sender may write to the conversation (this
   * checks only the files' ownership). Returns the content blocks the `user_message` carries
   * (`ref`, in `ids` order):
   *
   * - more than `attachments.maxPerMessage`, or an id twice → `validation_failed` (path `files`);
   * - not found, another account's, deleted, or an expired draft → `file.not_found`;
   * - still uploading → `file.not_ready`;
   *   both with details `[{ path: "files", message, fileId }]`, for the web to mark the entry.
   *
   * Drafts become `ready` (no expiry; `source_conversation_id` set when it has none), and each
   * file gets the conversation's `attached` reference (`first_seq` when given; an existing one is
   * kept). A file may be attached in any number of the owner's conversations.
   */
  @Transactional({ propagation: "mandatory" })
  async attachForMessage(
    orgId: string,
    conversationId: string,
    accountId: string,
    ids: readonly string[],
    firstSeq?: number,
  ): Promise<LogContentBlock[]> {
    const unique = [...new Set(ids)];
    const max = this.config.get().attachments.maxPerMessage;
    if (ids.length > max) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "files", message: `At most ${max} files per message` },
      ]);
    }
    if (unique.length !== ids.length) {
      throw new ApiError("validation_failed", "Request validation failed", [
        { path: "files", message: "Each file may appear only once per message" },
      ]);
    }
    if (unique.length === 0) return [];
    const trx = this.db.db;
    const rows = await trx
      .selectFrom("files")
      .select([
        "id",
        "account_id",
        "name",
        "content_type",
        "size",
        "status",
        sql<boolean>`expires_at IS NOT NULL AND expires_at <= now()`.as("expired"),
      ])
      .where("org_id", "=", orgId)
      .where("id", "in", unique)
      .orderBy("id")
      .forUpdate()
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const blocks: LogContentBlock[] = [];
    const drafts: string[] = [];
    for (const id of unique) {
      const r = byId.get(id);
      if (
        !r ||
        r.account_id !== accountId ||
        r.status === "deleted" ||
        (r.status !== "ready" && r.expired)
      ) {
        const message = `File ${id} not found or expired`;
        throw new ApiError("file.not_found", message, [{ path: "files", message, fileId: id }]);
      }
      if (r.status === "uploading") {
        const message = `File ${id} has not been finalized`;
        throw new ApiError("file.not_ready", message, [{ path: "files", message, fileId: id }]);
      }
      if (r.status === "draft") drafts.push(id);
      blocks.push(
        fileContentBlock({ id, name: r.name, contentType: r.content_type, size: Number(r.size) }),
      );
    }
    if (drafts.length > 0) {
      await trx
        .updateTable("files")
        .set({
          status: "ready",
          expires_at: null,
          source_conversation_id: sql<string>`coalesce(source_conversation_id, ${conversationId})`,
        })
        .where("org_id", "=", orgId)
        .where("id", "in", drafts)
        .execute();
    }
    await trx
      .insertInto("conversation_files")
      .values(
        unique.map((fileId) => ({
          conversation_id: conversationId,
          file_id: fileId,
          org_id: orgId,
          role: "attached" as const,
          first_seq: firstSeq ?? null,
        })),
      )
      // a file the conversation delivered and the person now sends into it becomes `attached`
      // (FetchAttachment copies only those); a repeated attachment keeps its first reference
      .onConflict((oc) =>
        oc
          .columns(["conversation_id", "file_id"])
          .doUpdateSet({ role: "attached" })
          .where("conversation_files.role", "=", "delivered"),
      )
      .execute();
    return blocks;
  }

  /**
   * Deletes one of the account's ready files from the library (file library spec §6; the owner
   * only, else `file.not_found`): `deleted` with `deleted_at`, its shares revoked
   * (`file_deleted`) in the same transaction. Its bytes stay until the blob sweep frees them after
   * `files.deletedRetentionDays`; conversations that referred to it show it as no longer available
   * and later model requests render the placeholder. Each referring conversation gets a `files`
   * change after the commit (a lost publish only delays the panel's refresh).
   */
  @Transactional()
  async delete(orgId: string, accountId: string, fileId: string): Promise<void> {
    const trx = this.db.db;
    const row = await trx
      .selectFrom("files")
      .select("id")
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("status", "=", "ready")
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    await trx
      .updateTable("files")
      .set({ status: "deleted", deleted_at: sql<Date>`now()`, expires_at: null })
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .execute();
    await revokeSharesIn(trx, { orgId, fileIds: [fileId] }, "file_deleted");
    const refs = await trx
      .selectFrom("conversation_files")
      .select("conversation_id")
      .where("org_id", "=", orgId)
      .where("file_id", "=", fileId)
      .execute();
    for (const r of refs) {
      afterCommit(() => this.eventLog.publishChanged(r.conversation_id, "files"));
    }
  }
}
