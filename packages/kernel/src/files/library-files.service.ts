import { createHash, randomUUID } from "node:crypto";
import { MEDIA_LIMITS, type ObjectStore, type PresignedUpload } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  countPdfPages,
  normalizeContentType,
  sniffMatches,
} from "../conversations/attachments.service.js";
import type { LogContentBlock } from "../conversations/events.js";
import { isImageContentType, isMediaContentType } from "../conversations/media-types.js";
import type { FileStatus } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { StorageService } from "../storage/storage.service.js";
import {
  afterUploadForm,
  FILE_UPLOAD_TTL_SECONDS,
  oweBlobDelete,
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
  sha256: string;
  etag: string | null;
  pages: number | null;
  sniffed: boolean;
}

/**
 * The files of the file library (file library spec §2–§4): account-owned rows over blobs.
 *
 * Uploading: `create` admits the upload and, unless the caller already holds the same bytes in a
 * file of their own, inserts an `uploading` row before presigning `uploads/<fileId>`. `finalize`
 * checks the staging object (size, type, signature, PDF pages), reads it whole to compute its
 * sha256, and resolves its blob in one transaction ({@link BlobsService.resolveUpload}); the work
 * and the answer do not depend on whether another account stored the same bytes. `discard` drops
 * a composer upload before it is sent; expired uploads and drafts go with {@link expireBatch}.
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
    @Inject(BlobsService) private readonly blobs: Pick<BlobsService, "resolveUpload">,
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
  ) {}

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
  private limitFor(contentType: string): number {
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
   * When one of the caller's own `ready` or unexpired `draft` files of the same type has a `ready`
   * blob with this sha256 and size, the new file is created on that blob at once (`upload: null`):
   * the caller already holds those bytes, so nothing is learned. In every other case (another
   * account's bytes included) an `uploading` row is inserted (expiring after
   * `attachments.unboundTtlHours`) before a form for `uploads/<fileId>` is presigned, the store
   * enforcing the declared size and type.
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

  /**
   * The instant path of {@link create}: a new file on the blob of one of the caller's own files,
   * or undefined. The blob is locked `FOR SHARE` and must still be `ready`, so a deletion claiming
   * it concurrently either waits for this file or makes the caller upload.
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
      .where("files.content_type", "=", input.contentType)
      .where((eb) =>
        eb.or([
          eb("files.status", "=", "ready"),
          eb.and([eb("files.status", "=", "draft"), eb("files.expires_at", ">", sql<Date>`now()`)]),
        ]),
      )
      .where("blobs.org_id", "=", orgId)
      .where("blobs.sha256", "=", input.sha256)
      .where("blobs.size", "=", String(input.size))
      .where("blobs.status", "=", "ready")
      .limit(1)
      .executeTakeFirst();
    if (!mine?.blob_id) return undefined;
    const blob = await trx
      .selectFrom("blobs")
      .select("id")
      .where("id", "=", mine.blob_id)
      .where("org_id", "=", orgId)
      .where("status", "=", "ready")
      .forShare()
      .executeTakeFirst();
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
        name: input.name,
        content_type: input.contentType,
        size: input.size,
        pages: mine.pages,
        origin: "upload",
        status: draft ? "draft" : "ready",
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
   * is): the staging object missing → `file.not_ready`; a size other than declared → the object
   * is deleted, larger `file.too_large`, smaller `file.not_ready` (upload again); a stored type or
   * a signature that does not match → deleted, `file.type_not_allowed`. The whole object is read
   * to compute its sha256; a hash other than `sha256` → the object is deleted, the upload expires,
   * `file.hash_mismatch`. Then one transaction resolves the blob and makes the file `draft`
   * (composer, expiring after `attachments.unboundTtlHours`) or `ready` (library).
   */
  async finalize(
    orgId: string,
    accountId: string,
    fileId: string,
    input: { sha256: string; purpose: UploadPurpose },
  ): Promise<FileView> {
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
    if (!head) throw new ApiError("file.not_ready", "The file has not been uploaded yet");
    const reject = async (err: ApiError): Promise<never> => {
      await store.delete(key);
      throw err;
    };
    if (head.size !== size) {
      await reject(
        head.size > size
          ? new ApiError("file.too_large", "Uploaded file is larger than declared")
          : new ApiError(
              "file.not_ready",
              `Uploaded file is ${head.size} bytes, but ${size} bytes were declared; upload it again`,
            ),
      );
    }
    if (normalizeContentType(head.contentType) !== row.content_type) {
      await reject(new ApiError("file.type_not_allowed", "Uploaded file type does not match"));
    }
    const read = await this.readUpload(store, key, row.content_type, size);
    if (!read) {
      await store.delete(key);
      throw new ApiError(
        "file.not_ready",
        "The uploaded file changed while it was checked; upload it again",
      );
    }
    if (!read.sniffed) {
      await reject(
        new ApiError("file.type_not_allowed", `Uploaded file content is not ${row.content_type}`),
      );
    }
    if (read.sha256 !== input.sha256) {
      await store.delete(key);
      await this.expireUpload(orgId, fileId);
      throw new ApiError(
        "file.hash_mismatch",
        "The uploaded bytes do not match the declared sha256; upload the file again",
      );
    }
    return this.commitFinalize(orgId, accountId, fileId, input.purpose, {
      sha256: read.sha256,
      size,
      etag: read.etag ?? head.etag ?? null,
      stagingKey: key,
      createdAt: row.created_at,
      pages: read.pages,
    });
  }

  /**
   * Streams the whole staging object once: its sha256, its leading bytes' signature check and,
   * for a PDF, its page count. Null when the object vanished or no longer has the declared size.
   */
  private async readUpload(
    store: ObjectStore,
    key: string,
    contentType: string,
    size: number,
  ): Promise<ReadUpload | null> {
    const got = await store.get(key);
    if (!got) return null;
    if (got.head.size !== size) {
      await got.body.cancel().catch(() => {});
      return null;
    }
    const hash = createHash("sha256");
    const pdf = contentType === "application/pdf";
    const kept: Uint8Array[] = [];
    let keptBytes = 0;
    let total = 0;
    for await (const chunk of got.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      total += chunk.byteLength;
      if (pdf || keptBytes < SNIFF_BYTES) {
        kept.push(chunk);
        keptBytes += chunk.byteLength;
      }
    }
    if (total !== size) return null;
    const bytes = Buffer.concat(kept);
    return {
      sha256: hash.digest("hex"),
      etag: got.head.etag ?? null,
      pages: pdf ? countPdfPages(bytes) || null : null,
      sniffed: sniffMatches(contentType, bytes.subarray(0, SNIFF_BYTES)),
    };
  }

  /** A mismatched upload expires now (the cleanup job drops it). */
  @Transactional()
  private async expireUpload(orgId: string, fileId: string): Promise<void> {
    await this.db.db
      .updateTable("files")
      .set({ expires_at: sql<Date>`now()` })
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .where("status", "=", "uploading")
      .execute();
  }

  /** The transaction of {@link finalize}: the file row locked, its blob resolved, the file set. */
  @Transactional()
  private async commitFinalize(
    orgId: string,
    accountId: string,
    fileId: string,
    purpose: UploadPurpose,
    v: {
      sha256: string;
      size: number;
      etag: string | null;
      stagingKey: string;
      createdAt: Date;
      pages: number | null;
    },
  ): Promise<FileView> {
    const trx = this.db.db;
    const locked = await trx
      .selectFrom("files")
      .select(UPLOAD_COLUMNS)
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) throw notFound();
    // a concurrent finalize, a discard or the cleanup got here first
    if (locked.status !== "uploading") return viewOf(locked);
    const { blob } = await this.blobs.resolveUpload(orgId, accountId, fileId, v);
    const draft = purpose === "composer";
    const ttlHours = this.config.get().attachments.unboundTtlHours;
    await trx
      .updateTable("files")
      .set({
        blob_id: blob.id,
        status: draft ? "draft" : "ready",
        pages: v.pages,
        expires_at: draft ? sql<Date>`now() + make_interval(hours => ${ttlHours})` : null,
      })
      .where("id", "=", fileId)
      .where("org_id", "=", orgId)
      .execute();
    return viewOf({ ...locked, status: draft ? "draft" : "ready" });
  }

  /**
   * A composer upload removed before it was sent (the uploader only; an `uploading` or `draft`
   * file no conversation refers to, else `file.not_found`): `deleted`, and its staging object or
   * own adopted blob released ({@link releaseUpload}).
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
    await this.releaseUpload(orgId, row);
  }

  /**
   * Expires one batch of the org's `uploading` / `draft` files past `expires_at` (`FOR UPDATE SKIP
   * LOCKED`, so concurrent runs never share a row): each becomes `deleted` and its staging object
   * or own adopted blob is released ({@link releaseUpload}). Returns how many it took.
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
    for (const r of rows) await this.releaseUpload(orgId, r);
    return rows.length;
  }

  /**
   * The bytes an upload leaves behind when its file is dropped before use, in the caller's
   * transaction (which holds the file row):
   *
   * - no blob yet → the staging object's deletion is owed;
   * - a `ready` blob that adopted this file's own staging object and that no other file or share
   *   points at → the file lets go of it, the blob becomes `deleting` and its deletion is owed;
   * - any other blob is shared (or not this upload's) and is left to the blob sweep.
   *
   * The blob is locked `FOR UPDATE` before the "no other reference" check, so a concurrent reuse
   * (which locks it `FOR SHARE` and must find it `ready`) either commits first and is seen, or
   * finds it `deleting`. Deletions run once the upload form expired.
   */
  @Transactional({ propagation: "mandatory" })
  private async releaseUpload(
    orgId: string,
    row: Pick<UploadRow, "id" | "blob_id" | "staging_key" | "created_at">,
  ): Promise<void> {
    const trx = this.db.db;
    const key = row.staging_key ?? stagingObjectKey(row.id);
    const runAt = afterUploadForm(row.created_at);
    if (row.blob_id === null) {
      await oweStagingDelete(this.outbox, orgId, row.id, key, runAt);
      return;
    }
    const blob = await trx
      .selectFrom("blobs")
      .select(["id", "object_key", "status"])
      .where("id", "=", row.blob_id)
      .where("org_id", "=", orgId)
      .forUpdate()
      .executeTakeFirst();
    if (blob?.status !== "ready" || blob.object_key !== key) return;
    const otherFile = await trx
      .selectFrom("files")
      .select("id")
      .where("org_id", "=", orgId)
      .where("blob_id", "=", blob.id)
      .where("id", "<>", row.id)
      .limit(1)
      .executeTakeFirst();
    const share = await trx
      .selectFrom("file_shares")
      .select("id")
      .where("org_id", "=", orgId)
      .where("blob_id", "=", blob.id)
      .limit(1)
      .executeTakeFirst();
    if (otherFile || share) return;
    await trx
      .updateTable("files")
      .set({ blob_id: null })
      .where("id", "=", row.id)
      .where("org_id", "=", orgId)
      .execute();
    await trx
      .updateTable("blobs")
      .set({ status: "deleting" })
      .where("id", "=", blob.id)
      .where("org_id", "=", orgId)
      .execute();
    await oweBlobDelete(this.outbox, orgId, blob.id, runAt);
  }

  /**
   * Attaches the sender's files to a message, in the message's transaction (rows `FOR UPDATE`, in
   * id order), and returns the content blocks the `user_message` carries (`ref`, in `ids` order):
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
      .onConflict((oc) => oc.columns(["conversation_id", "file_id"]).doNothing())
      .execute();
    return blocks;
  }
}
