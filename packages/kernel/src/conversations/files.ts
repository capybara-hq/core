import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { StorageService } from "../storage/storage.service.js";
import { UUID_RE } from "../ui/registry.js";
import { ConversationAccess } from "./access.js";
import { isInlineArtifactType, isTextArtifactType } from "./artifacts.js";
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

type Delivery = EventPayload<"artifact_created"> & { createdAt: Date };

/** A ready chat attachment bound to the conversation. */
interface Upload {
  id: string;
  name: string;
  contentType: string;
  size: number;
  objectKey: string;
  /** The etag recorded at finalize (null: not recorded); a different object is not the upload. */
  etag: string | null;
  createdAt: Date;
}

/** One entry of the merged list: a delivered file (its versions) or an uploaded one. */
type Entry =
  | { origin: "delivered"; at: Date; id: string; group: Delivery[] }
  | { origin: "uploaded"; at: Date; id: string; upload: Upload };

/** Whether `a` lists before `b`: newer first, then the larger id (a total, stable order). */
const before = (a: Entry, b: Entry): boolean =>
  a.at.getTime() !== b.at.getTime() ? a.at.getTime() > b.at.getTime() : a.id > b.id;

const previewKind = (contentType: string): FileOutput["previewable"] =>
  isInlineArtifactType(contentType) ? "image" : isTextArtifactType(contentType) ? "text" : null;

/** Drops an incomplete UTF-8 sequence at the end of a cut buffer. */
function trimUtf8(b: Buffer): Buffer {
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

async function readPrefix(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer> {
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
   * The conversation's ready `chat` attachments in this org (never a skill package, an avatar, a
   * pending or unbound upload), newest first; with `id`, only that one.
   */
  private async uploads(orgId: string, conversationId: string, id?: string): Promise<Upload[]> {
    let q = this.db
      .selectFrom("attachments")
      .select(["id", "name", "content_type", "size", "object_key", "etag", "created_at"])
      .where("org_id", "=", orgId)
      .where("conversation_id", "=", conversationId)
      .where("purpose", "=", "chat")
      .where("status", "=", "ready");
    if (id !== undefined) q = q.where("id", "=", id);
    const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      contentType: r.content_type,
      size: Number(r.size),
      objectKey: r.object_key,
      etag: r.etag,
      createdAt: r.created_at,
    }));
  }

  /**
   * One file of the conversation by id: a delivered version first, then an attachment sent in it;
   * neither → `conversation.artifact_not_found`. Call after {@link checkAccess}.
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
    etag: string | null;
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
        etag: null,
      };
    }
    const [u] = await this.uploads(orgId, conversationId, fileId);
    if (!u) throw artifactNotFound();
    return {
      id: u.id,
      name: u.name,
      contentType: u.contentType,
      size: u.size,
      objectKey: u.objectKey,
      etag: u.etag,
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
    const uploaded: Entry[] = (await this.uploads(orgId, conversationId)).map((u) => ({
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
    const store = this.storage.kernel(orgId);
    const files = await mapLimit(page, HEAD_CONCURRENCY, async (e): Promise<FileOutput> => {
      if (e.origin === "uploaded") {
        const u = e.upload;
        const head = await store.head(u.objectKey);
        const same = head !== null && (u.etag === null || u.etag === (head.etag ?? null));
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
      };
    });
    const next = start + opts.limit < ordered.length ? (files.at(-1)?.id ?? null) : null;
    return { files, next };
  }

  /**
   * One file version of the conversation (any version's id, or an attachment sent in it) with its
   * object key, after checking the viewer can read the conversation. For the kernel only
   * (previewers, embed grants): the key never leaves the kernel.
   */
  async file(
    orgId: string,
    conversationId: string,
    viewer: string,
    fileId: string,
  ): Promise<{ id: string; name: string; contentType: string; size: number; objectKey: string }> {
    await this.checkAccess(orgId, conversationId, viewer);
    const { etag: _etag, ...f } = await this.resolve(orgId, conversationId, fileId);
    return f;
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
    // an attachment whose object changed after finalize is not the upload any more
    if (!got || (a.etag !== null && a.etag !== (got.head.etag ?? null))) {
      await got?.body.cancel().catch(() => {});
      throw new ApiError("conversation.artifact_removed", "The file is no longer available");
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
