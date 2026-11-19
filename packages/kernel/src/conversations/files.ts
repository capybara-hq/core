import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { StorageService } from "../storage/storage.service.js";
import { UUID_RE } from "../ui/registry.js";
import { ConversationAccess } from "./access.js";
import { isInlineArtifactType, isTextArtifactType } from "./artifacts.js";
import { AttachmentsService, type BoundAttachment } from "./attachments.service.js";
import type { EventPayload } from "./events.js";

/**
 * A conversation's files (UI refresh B, spec §5.8 / §5.9): the files the agent delivered
 * (`artifact_created`), grouped by `sourcePath` into versions, and the files users sent in it
 * (ready `chat` attachments bound to the conversation), newest first. Read on every request (no
 * cache); `status` comes from the object store. Both kinds are read under the conversation's
 * access: whoever may read the conversation may read the attachments sent in it, nobody else.
 */

/** Versions listed per file (newest first). */
export const FILE_VERSIONS_MAX = 20;
/** Largest `limit` of the files list. */
export const FILES_PAGE_MAX = 100;
/** Largest `limit` (bytes) of the text content route. */
export const FILE_CONTENT_MAX_BYTES = 1024 * 1024;

export interface FileOutput {
  /** artifactId of the latest version. */
  id: string;
  name: string;
  contentType: string;
  size: number;
  sourcePath: string;
  /** 1-based count of deliveries with the same sourcePath, in log order. */
  version: number;
  /** Newest first, at most {@link FILE_VERSIONS_MAX}. */
  versions: { id: string; size: number; createdAt: Date }[];
  callId: string;
  createdAt: Date;
  /** `removed`: the latest version's object is gone from storage (decision 8). */
  status: "available" | "removed";
  previewable: "image" | "text" | null;
  /**
   * `delivered`: the agent delivered it (`artifact_created`); `uploaded`: a user sent it with a
   * message (an attachment: `id` is the attachment id, one version, `sourcePath` is its name and
   * `callId` is empty).
   */
  origin: "delivered" | "uploaded";
  /**
   * The viewer has a share of this file that is not revoked or expired (file sharing spec §5): of
   * its source path for a delivered file (any version), of the attachment for an uploaded one.
   */
  shared: boolean;
}

/** Text content of one file version, at most the requested bytes. */
export interface FileContent {
  body: Buffer;
  /**
   * Always `text/plain; charset=utf-8`: agent output is never served as a script, stylesheet or
   * page on the app origin (review I2).
   */
  contentType: string;
  /** The stored type without parameters (sent as `X-Content-Original-Type`). */
  originalType: string;
  truncated: boolean;
}

const conversationNotFound = () => new ApiError("conversation.not_found", "Conversation not found");
const artifactNotFound = () =>
  new ApiError("conversation.artifact_not_found", "Artifact not found");
const removed = () =>
  new ApiError("conversation.artifact_removed", "The file is no longer available");

type Delivery = EventPayload<"artifact_created"> & { createdAt: Date };

/** One entry of the merged list: a delivered file (its versions) or an uploaded one. */
type Entry =
  | { origin: "delivered"; at: Date; id: string; group: Delivery[] }
  | { origin: "uploaded"; at: Date; id: string; upload: BoundAttachment };

/** Whether `a` lists before `b`: newer first, then the larger id (a total, stable order). */
const before = (a: Entry, b: Entry): boolean =>
  a.at.getTime() !== b.at.getTime() ? a.at.getTime() > b.at.getTime() : a.id > b.id;

/** The built-in preview kind of a content type (the files list's `previewable`; share metadata too). */
export const previewKind = (contentType: string): FileOutput["previewable"] =>
  isInlineArtifactType(contentType) ? "image" : isTextArtifactType(contentType) ? "text" : null;

/** Drops an incomplete UTF-8 sequence at the end of a cut buffer. */
export function trimUtf8(b: Buffer): Buffer {
  let i = b.length - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && ((b[i] as number) & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i < 0) return b;
  const lead = b[i] as number;
  const need = lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : 0;
  return need > cont ? b.subarray(0, i) : b;
}

/** Reads at most `max` bytes of a stream, then cancels it. */
export async function readPrefix(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, Math.min(value.byteLength, max - n));
      chunks.push(take);
      n += take.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, n);
}

/** Storage HEADs a files list sends at once (review M1). */
export const HEAD_CONCURRENCY = 8;

/** `Promise.all(xs.map(fn))` with at most `limit` calls in flight; results in input order. */
async function mapLimit<T, R>(xs: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= xs.length) return;
      out[i] = await fn(xs[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}

@Injectable()
export class ConversationFiles {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    /** Same visibility as the event stream. */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    /** The attachments sent in the conversation, and the rule their stored content must meet. */
    @Inject(AttachmentsService)
    private readonly attachments: Pick<AttachmentsService, "boundRows" | "storedMatches">,
  ) {}

  private async checkAccess(orgId: string, conversationId: string, viewer: string) {
    if (!UUID_RE.test(conversationId)) throw conversationNotFound();
    if (!(await this.access.isAccessible(orgId, conversationId, viewer)))
      throw conversationNotFound();
  }

  /** Every delivery of the conversation in log order. */
  private async deliveries(conversationId: string): Promise<Delivery[]> {
    const rows = await this.db
      .selectFrom("conversation_events")
      .select(["payload", "created_at"])
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "artifact_created")
      .orderBy("seq")
      .execute();
    return rows.map((r) => ({
      ...(r.payload as EventPayload<"artifact_created">),
      createdAt: r.created_at,
    }));
  }

  /**
   * One file of the conversation by id: a delivered version first, then an attachment sent in it;
   * neither → `conversation.artifact_not_found`. An attachment carries `upload`, the row its stored
   * object must still match. Call after {@link checkAccess}.
   */
  private async resolve(
    orgId: string,
    conversationId: string,
    fileId: string,
  ): Promise<{
    id: string;
    name: string;
    contentType: string;
    size: number;
    objectKey: string;
    /** The version group of a delivered file; null for an attachment. */
    sourcePath: string | null;
    upload?: BoundAttachment;
  }> {
    if (!UUID_RE.test(fileId)) throw artifactNotFound();
    const row = await this.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "artifact_created")
      .where(sql<string>`payload->>'artifactId'`, "=", fileId)
      .limit(1)
      .executeTakeFirst();
    if (row) {
      const a = row.payload as EventPayload<"artifact_created">;
      return {
        id: a.artifactId,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        objectKey: a.objectKey,
        sourcePath: a.sourcePath,
      };
    }
    const [u] = await this.attachments.boundRows(orgId, conversationId, fileId);
    if (!u) throw artifactNotFound();
    return {
      id: u.id,
      name: u.name,
      contentType: u.contentType,
      size: u.size,
      objectKey: u.objectKey,
      sourcePath: null,
      upload: u,
    };
  }

  /**
   * Files newest first: a delivered file by its **first** delivery, so a new version keeps the
   * file's place and a cursor stays stable while files are re-delivered (review M2); an uploaded
   * file by its upload time; equal times by id. `after` is a file id from the previous page (any
   * version's id finds its file); a cursor that names no file gives an empty page. Storage HEADs run
   * at most {@link HEAD_CONCURRENCY} at a time.
   */
  async list(
    orgId: string,
    conversationId: string,
    viewer: string,
    opts: { after?: string; limit: number },
  ): Promise<{ files: FileOutput[]; next: string | null }> {
    await this.checkAccess(orgId, conversationId, viewer);
    const groups = new Map<string, Delivery[]>();
    for (const d of await this.deliveries(conversationId)) {
      // insertion order = first delivery (oldest first)
      const g = groups.get(d.sourcePath) ?? [];
      g.push(d);
      groups.set(d.sourcePath, g);
    }
    const delivered: Entry[] = [...groups.values()].reverse().map((g) => {
      const first = g[0] as Delivery;
      return { origin: "delivered", at: first.createdAt, id: first.artifactId, group: g };
    });
    // newest first, the larger id first at equal times
    const bound = (await this.attachments.boundRows(orgId, conversationId)).reverse();
    const uploaded: Entry[] = bound.map((u) => ({
      origin: "uploaded",
      at: u.createdAt,
      id: u.id,
      upload: u,
    }));
    // merge the two newest-first lists (each keeps its own order)
    const ordered: Entry[] = [];
    let i = 0;
    let j = 0;
    while (i < delivered.length || j < uploaded.length) {
      const d = delivered[i];
      const u = uploaded[j];
      if (d && (!u || before(d, u))) {
        ordered.push(d);
        i++;
      } else {
        ordered.push(u as Entry);
        j++;
      }
    }
    let start = 0;
    if (opts.after !== undefined) {
      const after = opts.after;
      const at = ordered.findIndex((e) =>
        e.origin === "delivered" ? e.group.some((d) => d.artifactId === after) : e.id === after,
      );
      if (at < 0) return { files: [], next: null };
      start = at + 1;
    }
    const page = ordered.slice(start, start + opts.limit);
    const shares = await this.viewerShares(conversationId, viewer);
    const store = this.storage.kernel(orgId);
    const files = await mapLimit(page, HEAD_CONCURRENCY, async (e): Promise<FileOutput> => {
      if (e.origin === "uploaded") {
        const u = e.upload;
        const head = await store.head(u.objectKey);
        const same = this.attachments.storedMatches(u, head, { orgId, conversationId });
        return {
          id: u.id,
          name: u.name,
          contentType: u.contentType,
          size: u.size,
          sourcePath: u.name,
          version: 1,
          versions: [{ id: u.id, size: u.size, createdAt: u.createdAt }],
          callId: "",
          createdAt: u.createdAt,
          status: same ? "available" : "removed",
          previewable: previewKind(u.contentType),
          origin: "uploaded",
          shared: shares.uploads.has(u.id),
        };
      }
      const g = e.group;
      const latest = g.at(-1) as Delivery;
      const head = await store.head(latest.objectKey);
      return {
        id: latest.artifactId,
        name: latest.name,
        contentType: latest.contentType,
        size: latest.size,
        sourcePath: latest.sourcePath,
        version: g.length,
        versions: g
          .slice(-FILE_VERSIONS_MAX)
          .reverse()
          .map((d) => ({ id: d.artifactId, size: d.size, createdAt: d.createdAt })),
        callId: latest.callId,
        createdAt: latest.createdAt,
        status: head ? "available" : "removed",
        previewable: previewKind(latest.contentType),
        origin: "delivered",
        shared: shares.paths.has(latest.sourcePath),
      };
    });
    const next = start + opts.limit < ordered.length ? (files.at(-1)?.id ?? null) : null;
    return { files, next };
  }

  /**
   * One file version of the conversation (any version's id, or an attachment sent in it) with its
   * object key, after checking the viewer can read the conversation. For the kernel only
   * (previewers, embed grants): the key never leaves the kernel. An attachment whose stored object
   * is gone or no longer the one finalize checked → `conversation.artifact_removed`; `recorded` is
   * then what a later read of the object must still match ({@link attachmentContentMatches}).
   * `sourcePath` is the version group of a delivered file, null for an attachment.
   */
  async file(
    orgId: string,
    conversationId: string,
    viewer: string,
    fileId: string,
  ): Promise<{
    id: string;
    name: string;
    contentType: string;
    size: number;
    objectKey: string;
    /** The version group of a delivered file; null for an attachment. */
    sourcePath: string | null;
    recorded?: { size: number; etag: string | null };
  }> {
    await this.checkAccess(orgId, conversationId, viewer);
    const { upload, ...f } = await this.resolve(orgId, conversationId, fileId);
    if (!upload) return f;
    const head = await this.storage.kernel(orgId).head(upload.objectKey);
    if (!this.attachments.storedMatches(upload, head, { orgId, conversationId })) throw removed();
    return { ...f, recorded: { size: upload.size, etag: upload.etag } };
  }

  /**
   * Which file a file id names (any version's id, or an attachment sent in the conversation), after
   * checking the viewer can read the conversation; storage is not read, so a removed file still
   * resolves (its shares are listed and revoked by it).
   */
  async identify(
    orgId: string,
    conversationId: string,
    viewer: string,
    fileId: string,
  ): Promise<{ id: string; sourcePath: string | null }> {
    await this.checkAccess(orgId, conversationId, viewer);
    const f = await this.resolve(orgId, conversationId, fileId);
    return { id: f.id, sourcePath: f.sourcePath };
  }

  /**
   * The newest delivered version of `sourcePath` whose object is still stored, after checking the
   * viewer can read the conversation (a share's "update to latest", file sharing spec §2); with
   * `after` (a version id), only versions delivered after it. Versions whose object is gone are
   * skipped; at most {@link FILE_VERSIONS_MAX} are looked at. Null when none is available.
   */
  async latestAvailable(
    orgId: string,
    conversationId: string,
    viewer: string,
    sourcePath: string,
    opts: { after?: string } = {},
  ): Promise<{
    id: string;
    name: string;
    contentType: string;
    size: number;
    objectKey: string;
  } | null> {
    await this.checkAccess(orgId, conversationId, viewer);
    const rows = await this.db
      .selectFrom("conversation_events")
      .select(["payload", "seq"])
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "artifact_created")
      .where(sql<string>`payload->>'sourcePath'`, "=", sourcePath)
      .orderBy("seq", "desc")
      .execute();
    let candidates = rows.map((r) => r.payload as EventPayload<"artifact_created">);
    if (opts.after !== undefined) {
      const at = candidates.findIndex((d) => d.artifactId === opts.after);
      if (at >= 0) candidates = candidates.slice(0, at);
    }
    const store = this.storage.kernel(orgId);
    for (const d of candidates.slice(0, FILE_VERSIONS_MAX)) {
      if (await store.head(d.objectKey)) {
        return {
          id: d.artifactId,
          name: d.name,
          contentType: d.contentType,
          size: d.size,
          objectKey: d.objectKey,
        };
      }
    }
    return null;
  }

  /**
   * The source paths and attachments the viewer has a share of in the conversation that is not
   * revoked or expired ({@link FileOutput.shared}).
   */
  private async viewerShares(
    conversationId: string,
    viewer: string,
  ): Promise<{ paths: Set<string>; uploads: Set<string> }> {
    const rows = await this.db
      .selectFrom("file_shares")
      .select(["source_path", "file_id"])
      .where("conversation_id", "=", conversationId)
      .where("created_by", "=", viewer)
      .where("revoked_at", "is", null)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", sql<Date>`now()`)]))
      .execute();
    const paths = new Set<string>();
    const uploads = new Set<string>();
    for (const r of rows) {
      if (r.source_path === null) uploads.add(r.file_id);
      else paths.add(r.source_path);
    }
    return { paths, uploads };
  }

  /**
   * The first `limit` bytes of a text file version (any version's id, or an attachment sent in the
   * conversation). Not text, or NUL bytes in
   * what was read → `conversation.artifact_not_previewable`; the object is gone →
   * `conversation.artifact_removed`. A cut never splits a UTF-8 character.
   */
  async content(
    orgId: string,
    conversationId: string,
    viewer: string,
    fileId: string,
    limit: number,
  ): Promise<FileContent> {
    await this.checkAccess(orgId, conversationId, viewer);
    const a = await this.resolve(orgId, conversationId, fileId);
    if (!isTextArtifactType(a.contentType)) {
      throw new ApiError("conversation.artifact_not_previewable", "Only text files have content");
    }
    const max = Math.min(limit, FILE_CONTENT_MAX_BYTES);
    const got = await this.storage
      .kernel(orgId)
      .get(a.objectKey, { range: { start: 0, end: max - 1 } });
    if (!got) throw removed();
    // an attachment whose object changed after finalize is not the upload any more
    if (
      a.upload &&
      !this.attachments.storedMatches(a.upload, got.head, { orgId, conversationId })
    ) {
      await got.body.cancel().catch(() => {});
      throw removed();
    }
    let body = await readPrefix(got.body, max);
    if (body.includes(0)) {
      throw new ApiError(
        "conversation.artifact_not_previewable",
        "This file contains binary data and has no text content",
      );
    }
    const truncated = got.head.size > body.byteLength;
    if (truncated) body = trimUtf8(body);
    const base = (a.contentType.split(";")[0] ?? "").trim().toLowerCase();
    return { body, contentType: "text/plain; charset=utf-8", originalType: base, truncated };
  }
}
