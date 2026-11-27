import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import type { BlobRef } from "../files/blobs.service.js";
import {
  type FileReference,
  isLive,
  type ReferencedFile,
  ReferencedFiles,
} from "../files/referenced-files.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { UUID_RE } from "../ui/registry.js";
import { ConversationAccess } from "./access.js";
import { isInlineArtifactType, isTextArtifactType } from "./artifacts.js";

/**
 * A conversation's files (UI refresh B, spec §5.8 / §5.9; file library spec §2): the library files
 * the conversation refers to (`conversation_files`). Files an agent delivered or generated are
 * grouped by `source_path` into versions; files a person uploaded are listed one by one; newest
 * first. Read on every request (no cache); `status` comes from the file and its blob (a deleted
 * file, or a blob gone or replaced, is `removed`). Everything is read under the conversation's
 * access: whoever may read the conversation may read the files it refers to, nobody else.
 */

/** Versions listed per file (newest first). */
export const FILE_VERSIONS_MAX = 20;
/** Largest `limit` of the files list. */
export const FILES_PAGE_MAX = 100;
/** Largest `limit` (bytes) of the text content route. */
export const FILE_CONTENT_MAX_BYTES = 1024 * 1024;

export interface FileOutput {
  /** The file id of the latest version (an artifact id for a delivery). */
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
  /** `removed`: the latest version's file was deleted or its bytes are gone (decision 8). */
  status: "available" | "removed";
  previewable: "image" | "text" | null;
  /**
   * `delivered`: an agent delivered or generated it (`artifact_created`); `uploaded`: a person
   * uploaded it and sent it with a message (one version, `sourcePath` is its name and `callId` is
   * empty).
   */
  origin: "delivered" | "uploaded";
  /**
   * The viewer has a share of this file that is not revoked or expired (file sharing spec §5): of
   * its source path for a delivered file (any version), of the file for an uploaded one.
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

/** One entry of the merged list: a delivered file (its versions, oldest first) or an uploaded one. */
type Entry =
  | { origin: "delivered"; at: Date; id: string; group: FileReference[] }
  | { origin: "uploaded"; at: Date; id: string; upload: FileReference };

/** Whether `a` lists before `b`: newer first, then the larger id (a total, stable order). */
const before = (a: Entry, b: Entry): boolean =>
  a.at.getTime() !== b.at.getTime() ? a.at.getTime() > b.at.getTime() : a.id > b.id;

/**
 * Whether a file is listed as an upload in this conversation (one version) rather than a version of
 * one of its deliveries: everything the conversation got by a message (an upload, or a file another
 * conversation delivered that the person sent here), and anything without a version group.
 */
const isUpload = (f: FileReference): boolean => f.role === "attached" || f.sourcePath === null;

/** Log order of two deliveries of one conversation: the event that referred to each, then time. */
const deliveryOrder = (a: FileReference, b: FileReference): number => {
  if (a.firstSeq !== null && b.firstSeq !== null && a.firstSeq !== b.firstSeq) {
    return a.firstSeq - b.firstSeq;
  }
  const t = a.referencedAt.getTime() - b.referencedAt.getTime();
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** One readable file version of the conversation, for the kernel only (the key never leaves it). */
export interface ResolvedConversationFile {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** The blob's key (relative to the org's kernel prefix). */
  objectKey: string;
  /** The version group of a delivered file; null for an upload. */
  sourcePath: string | null;
  /** What a later read of the object must still match (`blobContentMatches`). */
  recorded: { size: number; etag: string | null };
  /** The blob, for `BlobsService.open` / `head`. */
  blob: BlobRef;
}

const resolvedOf = (f: ReferencedFile): ResolvedConversationFile => ({
  id: f.id,
  name: f.name,
  contentType: f.contentType,
  size: f.size,
  objectKey: f.blob.objectKey,
  sourcePath: isUpload(f) ? null : f.sourcePath,
  recorded: { size: f.blob.size, etag: f.blob.etag },
  blob: { id: f.blob.id, objectKey: f.blob.objectKey, size: f.blob.size, etag: f.blob.etag },
});

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
    /** Same visibility as the event stream. */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    /** The files the conversation refers to, and their bytes (size and etag checked). */
    @Inject(ReferencedFiles)
    private readonly files: Pick<ReferencedFiles, "references" | "open" | "head">,
  ) {}

  private async checkAccess(orgId: string, conversationId: string, viewer: string) {
    if (!UUID_RE.test(conversationId)) throw conversationNotFound();
    if (!(await this.access.isAccessible(orgId, conversationId, viewer)))
      throw conversationNotFound();
  }

  /** Whether a reference can be read now: live, and its stored head still the recorded bytes. */
  private async available(orgId: string, f: FileReference): Promise<boolean> {
    return isLive(f) && (await this.files.head(orgId, f)) !== null;
  }

  /**
   * One file the conversation refers to by id (any status: a deleted file still resolves, so its
   * shares are found); none → `conversation.artifact_not_found`. Call after {@link checkAccess}.
   */
  private async resolve(
    orgId: string,
    conversationId: string,
    fileId: string,
  ): Promise<FileReference> {
    if (!UUID_RE.test(fileId)) throw artifactNotFound();
    const [f] = await this.files.references(orgId, [conversationId], { ids: [fileId] });
    if (!f) throw artifactNotFound();
    return f;
  }

  /** The tool call of each delivery logged in the conversation, by artifact (= file) id. */
  private async callIds(conversationId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .selectFrom("conversation_events")
      .select([
        sql<string>`payload->>'artifactId'`.as("id"),
        sql<string>`payload->>'callId'`.as("callId"),
      ])
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "artifact_created")
      .execute();
    return new Map(rows.map((r) => [r.id, r.callId]));
  }

  /**
   * Files newest first: a delivered file by its **first** delivery, so a new version keeps the
   * file's place and a cursor stays stable while files are re-delivered (review M2); an uploaded
   * file by when the conversation started referring to it; equal times by id. `after` is a file id
   * from the previous page (any version's id finds its file); a cursor that names no file gives an
   * empty page. Storage HEADs run at most {@link HEAD_CONCURRENCY} at a time.
   */
  async list(
    orgId: string,
    conversationId: string,
    viewer: string,
    opts: { after?: string; limit: number },
  ): Promise<{ files: FileOutput[]; next: string | null }> {
    await this.checkAccess(orgId, conversationId, viewer);
    const refs = await this.files.references(orgId, [conversationId]);
    const groups = new Map<string, FileReference[]>();
    const uploads: FileReference[] = [];
    for (const f of refs) {
      if (isUpload(f)) {
        uploads.push(f);
        continue;
      }
      const g = groups.get(f.sourcePath as string) ?? [];
      g.push(f);
      groups.set(f.sourcePath as string, g);
    }
    const delivered: Entry[] = [...groups.values()]
      .map((g) => g.sort(deliveryOrder))
      .map((g): Entry => {
        const first = g[0] as FileReference;
        return { origin: "delivered", at: first.referencedAt, id: first.id, group: g };
      })
      .sort((a, b) => (before(a, b) ? -1 : 1));
    // newest first, the larger id first at equal times
    const uploaded: Entry[] = uploads
      .map((u): Entry => ({ origin: "uploaded", at: u.referencedAt, id: u.id, upload: u }))
      .sort((a, b) => (before(a, b) ? -1 : 1));
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
        e.origin === "delivered" ? e.group.some((d) => d.id === after) : e.id === after,
      );
      if (at < 0) return { files: [], next: null };
      start = at + 1;
    }
    const page = ordered.slice(start, start + opts.limit);
    const shares = await this.viewerShares(orgId, conversationId, viewer);
    const calls = page.some((e) => e.origin === "delivered")
      ? await this.callIds(conversationId)
      : new Map<string, string>();
    const files = await mapLimit(page, HEAD_CONCURRENCY, async (e): Promise<FileOutput> => {
      if (e.origin === "uploaded") {
        const u = e.upload;
        return {
          id: u.id,
          name: u.name,
          contentType: u.contentType,
          size: u.size,
          sourcePath: u.name,
          version: 1,
          versions: [{ id: u.id, size: u.size, createdAt: u.referencedAt }],
          callId: "",
          createdAt: u.referencedAt,
          status: (await this.available(orgId, u)) ? "available" : "removed",
          previewable: previewKind(u.contentType),
          origin: "uploaded",
          shared: shares.uploads.has(u.id),
        };
      }
      const g = e.group;
      const latest = g.at(-1) as FileReference;
      const sourcePath = latest.sourcePath as string;
      return {
        id: latest.id,
        name: latest.name,
        contentType: latest.contentType,
        size: latest.size,
        sourcePath,
        version: g.length,
        versions: g
          .slice(-FILE_VERSIONS_MAX)
          .reverse()
          .map((d) => ({ id: d.id, size: d.size, createdAt: d.referencedAt })),
        callId: calls.get(latest.id) ?? "",
        createdAt: latest.referencedAt,
        status: (await this.available(orgId, latest)) ? "available" : "removed",
        previewable: previewKind(latest.contentType),
        origin: "delivered",
        shared: shares.paths.has(sourcePath),
      };
    });
    const next = start + opts.limit < ordered.length ? (files.at(-1)?.id ?? null) : null;
    return { files, next };
  }

  /**
   * One file version of the conversation (any version's id, or an upload sent in it) with its
   * blob, after checking the viewer can read the conversation. For the kernel only (previewers,
   * embed grants, documents): the key never leaves the kernel. A deleted file, or a blob gone or no
   * longer the recorded bytes → `conversation.artifact_removed`; `recorded` is what a later read of
   * the object must still match. `sourcePath` is the version group of a delivered file, null for
   * an upload.
   */
  async file(
    orgId: string,
    conversationId: string,
    viewer: string,
    fileId: string,
  ): Promise<ResolvedConversationFile> {
    await this.checkAccess(orgId, conversationId, viewer);
    const f = await this.resolve(orgId, conversationId, fileId);
    if (!isLive(f) || (await this.files.head(orgId, f)) === null) throw removed();
    return resolvedOf(f);
  }

  /**
   * Which file a file id names (any version's id, or an upload sent in the conversation), after
   * checking the viewer can read the conversation; storage is not read, and a deleted file still
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
    return { id: f.id, sourcePath: isUpload(f) ? null : f.sourcePath };
  }

  /**
   * The newest delivered version of `sourcePath` the conversation refers to that is still
   * readable, after checking the viewer can read the conversation (a share's "update to latest",
   * file sharing spec §2); with `after` (a version id), only versions delivered after it. Versions
   * deleted or whose bytes are gone are skipped; at most {@link FILE_VERSIONS_MAX} are looked at.
   * Null when none is available.
   */
  async latestAvailable(
    orgId: string,
    conversationId: string,
    viewer: string,
    sourcePath: string,
    opts: { after?: string } = {},
  ): Promise<ResolvedConversationFile | null> {
    await this.checkAccess(orgId, conversationId, viewer);
    const refs = await this.files.references(orgId, [conversationId]);
    let candidates = refs
      .filter((f) => !isUpload(f) && f.sourcePath === sourcePath)
      .sort(deliveryOrder)
      .reverse();
    if (opts.after !== undefined) {
      const at = candidates.findIndex((d) => d.id === opts.after);
      if (at >= 0) candidates = candidates.slice(0, at);
    }
    for (const d of candidates.slice(0, FILE_VERSIONS_MAX)) {
      if (isLive(d) && (await this.files.head(orgId, d)) !== null) return resolvedOf(d);
    }
    return null;
  }

  /**
   * The source paths and uploads the viewer has a share of in the conversation that is not
   * revoked or expired ({@link FileOutput.shared}).
   */
  private async viewerShares(
    orgId: string,
    conversationId: string,
    viewer: string,
  ): Promise<{ paths: Set<string>; uploads: Set<string> }> {
    const rows = await this.db
      .selectFrom("file_shares")
      .select(["source_path", "file_id"])
      .where("org_id", "=", orgId)
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
   * The first `limit` bytes of a text file version (any version's id, or an upload sent in the
   * conversation). Not text, or NUL bytes in what was read → `conversation.artifact_not_previewable`;
   * the file deleted or its bytes gone → `conversation.artifact_removed`. A cut never splits a
   * UTF-8 character.
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
    if (!isLive(a)) throw removed();
    const max = Math.min(limit, FILE_CONTENT_MAX_BYTES);
    const got = await this.files.open(orgId, a, { range: { start: 0, end: max - 1 } });
    if (!got) throw removed();
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
