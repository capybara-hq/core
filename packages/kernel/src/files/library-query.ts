import { Inject, Injectable } from "@nestjs/common";
import { type RawBuilder, sql } from "kysely";
import {
  ARTIFACT_DOWNLOAD_TTL_SECONDS,
  isInlineArtifactType,
  isTextArtifactType,
} from "../conversations/artifacts.js";
import {
  FILE_CONTENT_MAX_BYTES,
  FILE_VERSIONS_MAX,
  type FileContent,
  previewKind,
  readPrefix,
  trimUtf8,
} from "../conversations/files.js";
import type { FileOrigin } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { StorageService } from "../storage/storage.service.js";
import { UUID_RE } from "../ui/registry.js";
import { type BlobRef, BlobsService } from "./blobs.service.js";
import type { LIBRARY_ORIGINS, LIBRARY_TYPES } from "./library.schemas.js";
import { ReferencedFiles } from "./referenced-files.js";

/** A conversation as the library shows it: the owner's own, `deleted` once they deleted it. */
export interface LibraryConversation {
  id: string;
  title: string | null;
  deleted: boolean;
}

/** One entry of the library list (`GET /files`): a file, or the newest version of a delivery. */
export interface LibraryFileView {
  id: string;
  name: string;
  contentType: string;
  size: number;
  origin: FileOrigin;
  /** The agent that delivered or generated it; null for an upload. */
  agentId: string | null;
  /** That agent's current name, when it can be read. */
  agentName?: string;
  /** Where it was delivered, or first sent; null when not known (or not the caller's). */
  sourceConversation: LibraryConversation | null;
  /** The ready versions of its delivery group (1 for an upload). */
  versions: number;
  createdAt: Date;
  /** The built-in preview kind (`image`, `text`), null otherwise. */
  previewable: "image" | "text" | null;
}

/** `GET /files/:id`: the view, the owner's conversations referring to it and its versions. */
export interface LibraryFileDetails {
  file: LibraryFileView;
  conversations: LibraryConversation[];
  /** Newest first, at most {@link FILE_VERSIONS_MAX}. */
  versions: { id: string; size: number; createdAt: Date }[];
}

/** `GET /files/usage`: the caller's ready files and the bytes of the distinct blobs they use. */
export interface LibraryUsage {
  bytes: number;
  files: number;
}

/** A library file whose bytes can be read now, for the kernel only (the key never leaves it). */
export interface LiveLibraryFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  blob: BlobRef;
}

export type LibraryOriginFilter = (typeof LIBRARY_ORIGINS)[number];
export type LibraryTypeFilter = (typeof LIBRARY_TYPES)[number];

/** `GET /files`' filters and page. */
export interface LibraryListOptions {
  origin?: LibraryOriginFilter;
  agentId?: string;
  type?: LibraryTypeFilter;
  q?: string;
  limit: number;
  cursor?: string;
}

const notFound = () => new ApiError("file.not_found", "File not found");
const gone = () => new ApiError("file.deleted", "The file is no longer available");
const badCursor = () =>
  new ApiError("validation_failed", "Request validation failed", [
    { path: "cursor", message: "Pass the next value of the previous page" },
  ]);

/** The content type without parameters, lower case (SQL). */
const baseType = sql<string>`lower(btrim(split_part(f.content_type, ';', 1)))`;

/**
 * The family `GET /files?type=` filters by: `image/*`; PDF and office documents; `text/*` and the
 * text formats the previews read; everything else.
 */
const typeFamily: RawBuilder<string> = sql<string>`CASE
  WHEN ${baseType} LIKE 'image/%' THEN 'image'
  WHEN ${baseType} IN ('application/pdf', 'application/msword', 'application/rtf')
    OR ${baseType} LIKE 'application/vnd.openxmlformats-officedocument.%'
    OR ${baseType} LIKE 'application/vnd.ms-%'
    OR ${baseType} LIKE 'application/vnd.oasis.opendocument.%' THEN 'document'
  WHEN ${baseType} LIKE 'text/%'
    OR ${baseType} IN ('application/json', 'application/xml', 'application/yaml', 'application/sql')
    THEN 'text'
  ELSE 'other' END`;

/**
 * The version group of a file: the deliveries of one source path in one conversation share it;
 * anything else (an upload, a delivery whose conversation is not known) is its own group.
 */
const groupKey = sql<string>`CASE
  WHEN f.origin <> 'upload' AND f.source_path IS NOT NULL AND f.source_conversation_id IS NOT NULL
    THEN f.source_conversation_id || chr(10) || f.source_path
  ELSE f.id END`;

/** A cursor's time: UTC, microseconds (PG's precision; a JS `Date` would lose them). */
const CURSOR_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/;

const encodeCursor = (createdKey: string, id: string): string =>
  Buffer.from(JSON.stringify([createdKey, id]), "utf8").toString("base64url");

function decodeCursor(cursor: string): { createdKey: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw badCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw badCursor();
  const [createdKey, id] = parsed as unknown[];
  if (typeof createdKey !== "string" || !CURSOR_TIME_RE.test(createdKey)) throw badCursor();
  if (typeof id !== "string" || id === "" || id.length > 100) throw badCursor();
  return { createdKey, id };
}

type ViewRow = {
  id: string;
  name: string;
  content_type: string;
  size: string | number;
  origin: FileOrigin;
  agent_id: string | null;
  created_at: Date;
  versions: string | number;
  conv_id: string | null;
  conv_title: string | null;
  conv_deleted: boolean | null;
  agent_name: string | null;
};

const viewOf = (r: ViewRow): LibraryFileView => ({
  id: r.id,
  name: r.name,
  contentType: r.content_type,
  size: Number(r.size),
  origin: r.origin,
  agentId: r.agent_id,
  ...(r.agent_name !== null && { agentName: r.agent_name }),
  sourceConversation:
    r.conv_id === null
      ? null
      : { id: r.conv_id, title: r.conv_title, deleted: r.conv_deleted === true },
  versions: Number(r.versions),
  createdAt: r.created_at,
  previewable: previewKind(r.content_type),
});

/**
 * The read side of the Files page (file library spec §6, §8): the caller's own files only (a file
 * is visible to its owner alone), never another account's, whatever the org shares in blobs.
 * Bytes are read through the file's blob with its size and etag checked, never an event's key.
 * Read on every request; no process state.
 */
@Injectable()
export class LibraryQuery {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ReferencedFiles) private readonly files: Pick<ReferencedFiles, "owned">,
    @Inject(BlobsService) private readonly blobs: Pick<BlobsService, "open" | "head">,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
  ) {}

  /**
   * The views of the account's ready files of one org, newest first, deliveries of one source path
   * in one conversation collapsed to the newest with their `versions` count. `where` filters the
   * newest version (the entry); `limit` caps the rows.
   */
  private async views(
    orgId: string,
    accountId: string,
    where: RawBuilder<unknown>[],
    limit: number,
  ): Promise<(ViewRow & { created_key: string })[]> {
    // the filters (q, type, cursor, ...) apply after the window on purpose: the versions of one
    // path may have different names or types, and the entry is always the group's newest version
    const conditions = [sql`m.rank = 1`, ...where];
    const rows = await sql<ViewRow & { created_key: string }>`
      WITH mine AS (
        SELECT f.id, f.name, f.content_type, f.size, f.origin, f.agent_id,
          f.source_conversation_id, f.created_at, ${typeFamily} AS family,
          row_number() OVER (PARTITION BY ${groupKey} ORDER BY f.created_at DESC, f.id DESC) AS rank,
          count(*) OVER (PARTITION BY ${groupKey}) AS versions
        FROM capybara.files f
        WHERE f.org_id = ${orgId} AND f.account_id = ${accountId} AND f.status = 'ready'
      )
      SELECT m.id, m.name, m.content_type, m.size, m.origin, m.agent_id, m.created_at, m.versions,
        to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_key,
        c.id AS conv_id, c.title AS conv_title, (c.deleted_at IS NOT NULL) AS conv_deleted,
        (SELECT v.definition->>'name' FROM capybara.agents a
          JOIN capybara.agent_versions v ON v.agent_id = a.id AND v.version = a.current_version
          WHERE a.id = m.agent_id AND a.org_id = ${orgId}) AS agent_name
      FROM mine m
      LEFT JOIN capybara.conversations c ON c.id = m.source_conversation_id
        AND c.org_id = ${orgId} AND c.account_id = ${accountId}
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ${limit}`.execute(this.db.db);
    return rows.rows;
  }

  /**
   * `GET /files`: one page of the account's library (see {@link views}). `q` matches a
   * case-insensitive substring of the name; `next` is the cursor of the following page, null on
   * the last. A cursor this route did not hand out → 400 `validation_failed`.
   */
  async list(
    orgId: string,
    accountId: string,
    opts: LibraryListOptions,
  ): Promise<{ files: LibraryFileView[]; next: string | null }> {
    const where: RawBuilder<unknown>[] = [];
    if (opts.origin !== undefined) where.push(sql`m.origin = ${opts.origin}`);
    if (opts.agentId !== undefined) where.push(sql`m.agent_id = ${opts.agentId}`);
    if (opts.type !== undefined) where.push(sql`m.family = ${opts.type}`);
    if (opts.q !== undefined) where.push(sql`position(lower(${opts.q}) in lower(m.name)) > 0`);
    if (opts.cursor !== undefined) {
      const c = decodeCursor(opts.cursor);
      where.push(
        sql`(m.created_at, m.id) < (${c.createdKey}::timestamp AT TIME ZONE 'UTC', ${c.id})`,
      );
    }
    const rows = await this.views(orgId, accountId, where, opts.limit + 1);
    const page = rows.slice(0, opts.limit);
    const last = page.at(-1);
    return {
      files: page.map(viewOf),
      next: rows.length > opts.limit && last ? encodeCursor(last.created_key, last.id) : null,
    };
  }

  /** `GET /files/usage` (file library spec §8): other accounts' use of a blob never shows. */
  async usage(orgId: string, accountId: string): Promise<LibraryUsage> {
    const r = await sql<{ files: string; bytes: string | null }>`
      SELECT
        (SELECT count(*) FROM capybara.files f
          WHERE f.org_id = ${orgId} AND f.account_id = ${accountId} AND f.status = 'ready') AS files,
        (SELECT sum(b.size) FROM capybara.blobs b
          WHERE b.org_id = ${orgId} AND b.id IN (
            SELECT f.blob_id FROM capybara.files f
            WHERE f.org_id = ${orgId} AND f.account_id = ${accountId} AND f.status = 'ready'
          )) AS bytes`.execute(this.db.db);
    const row = r.rows[0];
    return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  /**
   * `GET /files/:id`: one of the account's ready files (any version of a delivery) with the
   * owner's conversations referring to it (oldest reference first) and the ready versions of its
   * group. Another account's, deleted or unknown → `file.not_found`.
   */
  async details(orgId: string, accountId: string, fileId: string): Promise<LibraryFileDetails> {
    if (!UUID_RE.test(fileId)) throw notFound();
    const row = await this.db.db
      .selectFrom("files")
      .select(["id", "origin", "source_conversation_id", "source_path", "size", "created_at"])
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("id", "=", fileId)
      .where("status", "=", "ready")
      .executeTakeFirst();
    if (!row) throw notFound();
    const grouped =
      row.origin !== "upload" && row.source_path !== null && row.source_conversation_id !== null;
    const group = () =>
      this.db.db
        .selectFrom("files")
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .where("status", "=", "ready")
        .where("origin", "<>", "upload")
        .where("source_conversation_id", "=", row.source_conversation_id as string)
        .where("source_path", "=", row.source_path as string);
    // the count is over every ready version (as the list counts), the listed ones are capped
    const count = grouped
      ? Number(
          (
            await group()
              .select((eb) => eb.fn.countAll<string>().as("n"))
              .executeTakeFirst()
          )?.n ?? 1,
        )
      : 1;
    const versions = grouped
      ? (
          await group()
            .select(["id", "size", "created_at"])
            .orderBy("created_at", "desc")
            .orderBy("id", "desc")
            .limit(FILE_VERSIONS_MAX)
            .execute()
        ).map((v) => ({ id: v.id, size: Number(v.size), createdAt: v.created_at }))
      : [{ id: row.id, size: Number(row.size), createdAt: row.created_at }];
    const [view] = await this.viewOfFile(orgId, accountId, fileId);
    if (!view) throw notFound();
    const conversations = await this.db.db
      .selectFrom("conversation_files as cf")
      .innerJoin("conversations as c", (j) =>
        j.onRef("c.id", "=", "cf.conversation_id").on("c.org_id", "=", orgId),
      )
      .select(["c.id", "c.title", "c.deleted_at"])
      .where("cf.org_id", "=", orgId)
      .where("cf.file_id", "=", fileId)
      .where("c.account_id", "=", accountId)
      .orderBy("cf.created_at")
      .orderBy("c.id")
      .execute();
    return {
      file: { ...view, versions: count },
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        deleted: c.deleted_at !== null,
      })),
      versions,
    };
  }

  /** The view of one ready file of the account (not collapsed: the file itself). */
  private async viewOfFile(
    orgId: string,
    accountId: string,
    fileId: string,
  ): Promise<LibraryFileView[]> {
    const rows = await sql<ViewRow>`
      SELECT f.id, f.name, f.content_type, f.size, f.origin, f.agent_id, f.created_at,
        1 AS versions, c.id AS conv_id, c.title AS conv_title,
        (c.deleted_at IS NOT NULL) AS conv_deleted,
        (SELECT v.definition->>'name' FROM capybara.agents a
          JOIN capybara.agent_versions v ON v.agent_id = a.id AND v.version = a.current_version
          WHERE a.id = f.agent_id AND a.org_id = ${orgId}) AS agent_name
      FROM capybara.files f
      LEFT JOIN capybara.conversations c ON c.id = f.source_conversation_id
        AND c.org_id = ${orgId} AND c.account_id = ${accountId}
      WHERE f.org_id = ${orgId} AND f.account_id = ${accountId} AND f.id = ${fileId}
        AND f.status = 'ready'`.execute(this.db.db);
    return rows.rows.map(viewOf);
  }

  /**
   * One of the account's files whose bytes can be read now (`ready`, or a `draft` of the
   * composer: `ReferencedFiles.owned`), its blob ready and its stored object still the recorded
   * bytes. Another account's, unknown or deleted → `file.not_found`; bytes gone → `file.deleted`.
   */
  async live(orgId: string, accountId: string, fileId: string): Promise<LiveLibraryFile> {
    if (!UUID_RE.test(fileId)) throw notFound();
    const f = await this.files.owned(orgId, accountId, fileId);
    if (f.blob === null || f.blob.status !== "ready") throw gone();
    const blob: BlobRef = {
      id: f.blob.id,
      objectKey: f.blob.objectKey,
      size: f.blob.size,
      etag: f.blob.etag,
    };
    if ((await this.blobs.head(orgId, blob)) === null) throw gone();
    return { id: f.id, name: f.name, contentType: f.contentType, size: f.size, blob };
  }

  /**
   * The first `limit` bytes of a text file (the conversation route's twin): not text, or NUL
   * bytes in what was read → `conversation.artifact_not_previewable`; a cut never splits a UTF-8
   * character.
   */
  async content(
    orgId: string,
    accountId: string,
    fileId: string,
    limit: number,
  ): Promise<FileContent> {
    const f = await this.live(orgId, accountId, fileId);
    if (!isTextArtifactType(f.contentType)) {
      throw new ApiError("conversation.artifact_not_previewable", "Only text files have content");
    }
    const max = Math.min(limit, FILE_CONTENT_MAX_BYTES);
    const got = await this.blobs.open(orgId, f.blob, { range: { start: 0, end: max - 1 } });
    if (!got) throw gone();
    let body = await readPrefix(got.body, max);
    if (body.includes(0)) {
      throw new ApiError(
        "conversation.artifact_not_previewable",
        "This file contains binary data and has no text content",
      );
    }
    const truncated = got.head.size > body.byteLength;
    if (truncated) body = trimUtf8(body);
    const base = (f.contentType.split(";")[0] ?? "").trim().toLowerCase();
    return { body, contentType: "text/plain; charset=utf-8", originalType: base, truncated };
  }

  /**
   * A presigned address of the file's bytes (the artifact download's twin): `attachment` with the
   * file's name and type; `inline` only for bitmaps.
   */
  async downloadUrl(
    orgId: string,
    accountId: string,
    fileId: string,
    opts: { inline?: boolean } = {},
  ): Promise<{ url: string; name: string }> {
    const f = await this.live(orgId, accountId, fileId);
    const inline = opts.inline === true && isInlineArtifactType(f.contentType);
    const url = await this.storage.kernel(orgId).presignGet(f.blob.objectKey, {
      ttlSeconds: ARTIFACT_DOWNLOAD_TTL_SECONDS,
      downloadName: f.name,
      disposition: inline ? "inline" : "attachment",
      responseContentType: f.contentType,
    });
    return { url, name: f.name };
  }
}
