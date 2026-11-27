import type { ObjectHead } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { FileOrigin, FileStatus } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { StorageService } from "../storage/storage.service.js";
import { type BlobRow, BlobsService } from "./blobs.service.js";

/** A library file row (file library spec §1). */
export interface LibraryFile {
  id: string;
  orgId: string;
  accountId: string;
  blobId: string | null;
  name: string;
  contentType: string;
  size: number;
  pages: number | null;
  origin: FileOrigin;
  status: FileStatus;
  agentId: string | null;
  sourceConversationId: string | null;
  sourcePath: string | null;
  /**
   * The key and etag of the blob the file was first stored on (`files.ref_key` / `ref_etag`): the
   * model-visible reference ({@link ReferencedFiles.modelRef}) stays the same when the file moves
   * to another blob. Null key: the blob's own.
   */
  refKey: string | null;
  refEtag: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

/**
 * A file one conversation refers to (`conversation_files`), with its blob (null when the file has
 * none any more). One entry per conversation and file: a file referred to by two conversations of
 * a set appears twice.
 */
export interface FileReference extends LibraryFile {
  blob: BlobRow | null;
  /** The conversation that refers to the file. */
  conversationId: string;
  role: "attached" | "delivered";
  /** The event that first referred to it; null when not known (migrated rows, queued messages). */
  firstSeq: number | null;
  /** When the conversation started referring to it. */
  referencedAt: Date;
}

/** A {@link FileReference} whose file is `ready` and whose blob is `ready`. */
export type ReferencedFile = FileReference & { blob: BlobRow };

/** A file sent into the conversation (`FetchAttachment`'s list). */
export interface AttachedFile {
  id: string;
  name: string;
  /** Whether it can be copied now (not deleted, its blob ready); names are assigned over all. */
  available: boolean;
  /** The unsigned reference the model saw in a reference line ({@link ReferencedFiles.uri}). */
  uri: string;
}

/** {@link ReferencedFiles.openForConversation}'s result. */
export interface OpenedFile {
  name: string;
  contentType: string;
  size: number;
  body: ReadableStream<Uint8Array>;
}

/** Whether a reference can be read: the file `ready` and its blob `ready`. */
export const isLive = (f: FileReference): f is ReferencedFile =>
  f.status === "ready" && f.blob !== null && f.blob.status === "ready";

const notFound = () => new ApiError("file.not_found", "File not found");

/** How many sub-agent levels {@link ReferencedFiles.referencedBelow} walks (the tree reads' bound). */
const TREE_LEVELS = 16;
/** The most referring sub-agent conversations {@link ReferencedFiles.referencedBelow} reads. */
const BELOW_LIMIT = 32;

type Row = {
  id: string;
  org_id: string;
  account_id: string;
  blob_id: string | null;
  name: string;
  content_type: string;
  size: string | number;
  pages: number | null;
  origin: FileOrigin;
  status: FileStatus;
  agent_id: string | null;
  source_conversation_id: string | null;
  source_path: string | null;
  ref_key: string | null;
  ref_etag: string | null;
  created_at: Date;
  deleted_at: Date | null;
  b_id: string | null;
  b_sha256: string | null;
  b_size: string | number | null;
  b_etag: string | null;
  b_object_key: string | null;
  b_status: BlobRow["status"] | null;
};

const toFile = (r: Row): LibraryFile & { blob: BlobRow | null } => ({
  id: r.id,
  orgId: r.org_id,
  accountId: r.account_id,
  blobId: r.blob_id,
  name: r.name,
  contentType: r.content_type,
  size: Number(r.size),
  pages: r.pages,
  origin: r.origin,
  status: r.status,
  agentId: r.agent_id,
  sourceConversationId: r.source_conversation_id,
  sourcePath: r.source_path,
  refKey: r.ref_key,
  refEtag: r.ref_etag,
  createdAt: r.created_at,
  deletedAt: r.deleted_at,
  blob:
    r.b_id === null
      ? null
      : {
          id: r.b_id,
          orgId: r.org_id,
          sha256: r.b_sha256,
          size: Number(r.b_size),
          etag: r.b_etag,
          objectKey: r.b_object_key as string,
          status: r.b_status as BlobRow["status"],
        },
});

/**
 * The read side of the file library for conversations (file library spec §2, §5): which files a
 * set of conversations refers to (`conversation_files` → `files` → `blobs`), and their bytes
 * through {@link BlobsService} (size and etag checked; never an event's `objectKey`). A file
 * reaches a conversation, its model or its device only through such a reference: a library file
 * the person never attached is not found here. Callers check who may read the conversations
 * first. No process state.
 */
@Injectable()
export class ReferencedFiles {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    @Inject(BlobsService) private readonly blobs: Pick<BlobsService, "open" | "head">,
  ) {}

  /** The file and blob columns, the blob's prefixed with `b_`. */
  private fileQuery(orgId: string) {
    return this.db
      .selectFrom("files as f")
      .leftJoin("blobs as b", (j) => j.onRef("b.id", "=", "f.blob_id").on("b.org_id", "=", orgId))
      .select([
        "f.id",
        "f.org_id",
        "f.account_id",
        "f.blob_id",
        "f.name",
        "f.content_type",
        "f.size",
        "f.pages",
        "f.origin",
        "f.status",
        "f.agent_id",
        "f.source_conversation_id",
        "f.source_path",
        "f.ref_key",
        "f.ref_etag",
        "f.created_at",
        "f.deleted_at",
        "b.id as b_id",
        "b.sha256 as b_sha256",
        "b.size as b_size",
        "b.etag as b_etag",
        "b.object_key as b_object_key",
        "b.status as b_status",
      ])
      .where("f.org_id", "=", orgId);
  }

  /**
   * Every reference of the conversations (any file status, any blob state: a deleted file stays
   * listed so the conversation can show it as no longer available), oldest reference first, then
   * the file id; with `ids`, only those files; with `role`, only that role.
   */
  async references(
    orgId: string,
    conversationIds: readonly string[],
    opts: { ids?: readonly string[]; role?: FileReference["role"] } = {},
  ): Promise<FileReference[]> {
    if (conversationIds.length === 0 || opts.ids?.length === 0) return [];
    let q = this.fileQuery(orgId)
      .innerJoin("conversation_files as cf", (j) =>
        j.onRef("cf.file_id", "=", "f.id").on("cf.org_id", "=", orgId),
      )
      .select(["cf.conversation_id", "cf.role", "cf.first_seq", "cf.created_at as referenced_at"])
      .where("cf.conversation_id", "in", [...new Set(conversationIds)]);
    if (opts.ids !== undefined) q = q.where("f.id", "in", [...new Set(opts.ids)]);
    if (opts.role !== undefined) q = q.where("cf.role", "=", opts.role);
    const rows = await q.orderBy("cf.created_at").orderBy("f.id").execute();
    return rows.map((r) => ({
      ...toFile(r),
      conversationId: r.conversation_id,
      role: r.role,
      firstSeq: r.first_seq === null ? null : Number(r.first_seq),
      referencedAt: r.referenced_at,
    }));
  }

  /**
   * The files any of the conversations refers to that can be read now (the file `ready`, its blob
   * `ready`), as {@link references} orders them; with `ids`, only those files.
   */
  async referenced(
    orgId: string,
    conversationIds: readonly string[],
    ids?: readonly string[],
  ): Promise<ReferencedFile[]> {
    const refs = await this.references(orgId, conversationIds, ids === undefined ? {} : { ids });
    return refs.filter(isLive);
  }

  /**
   * One of the account's files that the account may use (file library spec §2): `ready`, or a
   * `draft` (the composer's own upload, not sent yet), with its blob; another account's, an unknown
   * id, an upload not finalized or a deleted file → `file.not_found`.
   */
  async owned(
    orgId: string,
    accountId: string,
    fileId: string,
  ): Promise<LibraryFile & { blob: BlobRow | null }> {
    const row = await this.fileQuery(orgId)
      .where("f.id", "=", fileId)
      .where("f.account_id", "=", accountId)
      .where("f.status", "in", ["ready", "draft"])
      .executeTakeFirst();
    if (!row) throw notFound();
    return toFile(row);
  }

  /**
   * What the model sees of a file's bytes, pinned to the blob the file was first stored on so a
   * later move to another blob (a hashing merge) changes no model-visible text and no replay etag:
   * `uri`, the store's unsigned reference of that key (else `capybara://attachments/<fileId>`, the
   * form logs already hold), and `etag` (with `refKey` set, `refEtag` as recorded; else the
   * blob's). Byte reads still check the current blob's own size and etag.
   */
  modelRef(
    orgId: string,
    f: Pick<LibraryFile, "id" | "refKey" | "refEtag"> & {
      blob: Pick<BlobRow, "objectKey" | "etag">;
    },
  ): { uri: string; etag: string | null } {
    const key = f.refKey ?? f.blob.objectKey;
    return {
      uri: this.storage.kernel(orgId).uri?.(key) ?? `capybara://attachments/${f.id}`,
      etag: f.refKey !== null ? f.refEtag : f.blob.etag,
    };
  }

  /**
   * The live files of id `fileId` that sub-agent conversations below `ancestorId` refer to (its
   * children, grandchildren …, at most {@link TREE_LEVELS} levels and {@link BELOW_LIMIT}
   * referring conversations): one query over the parent index joined to the references.
   */
  async referencedBelow(
    orgId: string,
    ancestorId: string,
    fileId: string,
  ): Promise<ReferencedFile[]> {
    const below = await sql<{ conversation_id: string }>`
      WITH RECURSIVE tree(id, level) AS (
        SELECT c.id, 1 FROM capybara.conversations c
        WHERE c.parent_conversation_id = ${ancestorId} AND c.org_id = ${orgId}
          AND c.kind = 'subagent'
        UNION ALL
        SELECT c.id, t.level + 1
        FROM capybara.conversations c JOIN tree t ON c.parent_conversation_id = t.id
        WHERE c.org_id = ${orgId} AND c.kind = 'subagent' AND t.level < ${TREE_LEVELS}
      )
      SELECT cf.conversation_id FROM capybara.conversation_files cf
      JOIN tree t ON t.id = cf.conversation_id
      WHERE cf.org_id = ${orgId} AND cf.file_id = ${fileId}
      LIMIT ${BELOW_LIMIT}`.execute(this.db.db);
    if (below.rows.length === 0) return [];
    return this.referenced(
      orgId,
      below.rows.map((r) => r.conversation_id),
      [fileId],
    );
  }

  /** A live file's bytes ({@link BlobsService.open}): null when the blob is certainly gone. */
  open(
    orgId: string,
    f: ReferencedFile,
    opts: { range?: { start: number; end?: number }; signal?: AbortSignal } = {},
  ): Promise<{ head: ObjectHead; body: ReadableStream<Uint8Array> } | null> {
    return this.blobs.open(orgId, f.blob, opts);
  }

  /** A live file's stored head ({@link BlobsService.head}): null when gone or replaced. */
  head(orgId: string, f: ReferencedFile): Promise<ObjectHead | null> {
    return this.blobs.head(orgId, f.blob);
  }

  /**
   * The files sent into the conversation (`FetchAttachment`): its `attached` references, oldest
   * reference first, then the id (a later attachment never moves an earlier one), each marked
   * `available` when it can be copied now. The copy assigns names over the whole list, so a file
   * deleted later never renames another.
   */
  async listForConversation(orgId: string, conversationId: string): Promise<AttachedFile[]> {
    const refs = await this.references(orgId, [conversationId], { role: "attached" });
    return refs.map((f) => ({
      id: f.id,
      name: f.name,
      available: isLive(f),
      uri: f.blob
        ? this.modelRef(orgId, { ...f, blob: f.blob }).uri
        : `capybara://attachments/${f.id}`,
    }));
  }

  /**
   * Opens one file sent into the conversation ({@link listForConversation}); null when it is not
   * one of them any more or its bytes are gone. Other errors (storage unavailable) throw. The
   * caller reads or cancels `body`.
   */
  async openForConversation(
    orgId: string,
    conversationId: string,
    fileId: string,
  ): Promise<OpenedFile | null> {
    const [f] = (
      await this.references(orgId, [conversationId], { ids: [fileId], role: "attached" })
    ).filter(isLive);
    if (!f) return null;
    const got = await this.open(orgId, f);
    if (!got) return null;
    return { name: f.name, contentType: f.contentType, size: f.size, body: got.body };
  }
}
