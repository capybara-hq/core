import type { AttachmentsService } from "../../conversations/attachments.service.js";
import type { ReferencedFiles } from "../../files/referenced-files.js";
import type { KernelDb } from "../../infra/database/kernel-db.js";

/**
 * A file of the conversation by id: a library file the conversation set refers to (an upload, a
 * delivery or a generated image) or a `read` copy (an image a tool showed the agent).
 */
export interface ConversationFile {
  /** `attachment`: an upload or a `read` copy; `artifact`: a delivered or generated file. */
  kind: "attachment" | "artifact";
  id: string;
  /**
   * For a `read` copy (an image a tool showed the agent), the conversation it is bound to: a
   * `Read` of a copy that is already the calling conversation's needs no new copy.
   */
  readCopyOf?: string;
  name: string;
  contentType: string;
  size: number;
  /**
   * Reads the bytes, at most `maxBytes` of them when given (the head of a larger file: the stream
   * is cancelled there). Call it, or {@link discard}, exactly once: the lookup holds the stream.
   */
  open(opts?: { maxBytes?: number }): Promise<Uint8Array>;
  /** Releases the file without reading it (a refusal before the bytes are needed). */
  discard(): Promise<void>;
}

export interface ConversationFileDeps {
  db: Pick<KernelDb, "selectFrom">;
  /** The `read` copies. */
  attachments: Pick<AttachmentsService, "openForConversation">;
  /**
   * The library files the conversations refer to, and their bytes. Absent (a caller not wired to
   * the library yet): no library file resolves, only `read` copies.
   */
  files?: Pick<ReferencedFiles, "referenced" | "referencingConversations" | "open">;
  /** Unused: bytes are read through `files` (kept so older callers' objects still fit). */
  storage?: unknown;
}

/** Lower-case or upper-case UUIDs: file and `read` copy ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The bytes of `body`, at most `maxBytes` (the stream is cancelled once that many are read: a
 * store that ignores a range still sends no more than one chunk past it).
 */
async function bytesOf(body: ReadableStream<Uint8Array>, maxBytes?: number): Promise<Uint8Array> {
  if (maxBytes === undefined) return new Uint8Array(await new Response(body).arrayBuffer());
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(n, maxBytes));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, out.length - at);
    out.set(part, at);
    at += part.length;
    if (at === out.length) break;
  }
  return out;
}

/** How many parent links {@link isBelow} follows at most (the tree reads' bound). */
const TREE_MAX_LEVELS = 16;

/**
 * Whether `candidate` is a sub-agent conversation below `ancestor` (its child, grandchild …),
 * walking `parent_conversation_id` inside `orgId`, at most {@link TREE_MAX_LEVELS} links.
 */
async function isBelow(
  db: ConversationFileDeps["db"],
  orgId: string,
  candidate: string,
  ancestor: string,
): Promise<boolean> {
  let at: string | null = candidate;
  for (let i = 0; i < TREE_MAX_LEVELS && at !== null; i++) {
    const row: { parent_conversation_id: string | null } | undefined = await db
      .selectFrom("conversations")
      .select("parent_conversation_id")
      .where("id", "=", at)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    at = row?.parent_conversation_id ?? null;
    if (at === ancestor) return true;
  }
  return false;
}

/**
 * The conversations of `orgId` an id belongs to: the conversations that refer to a library file of
 * that id, else the conversation a ready `read` copy of that id is bound to.
 */
async function ownersOf(
  deps: ConversationFileDeps,
  orgId: string,
  id: string,
): Promise<{ conversationIds: string[]; readCopy: boolean }> {
  const referring = (await deps.files?.referencingConversations(orgId, id)) ?? [];
  if (referring.length > 0) return { conversationIds: referring, readCopy: false };
  const att = await deps.db
    .selectFrom("attachments")
    .select("conversation_id")
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .where("status", "=", "ready")
    .where("purpose", "=", "read")
    .executeTakeFirst();
  return att?.conversation_id
    ? { conversationIds: [att.conversation_id], readCopy: true }
    : { conversationIds: [], readCopy: false };
}

/**
 * A file of the conversation by id, always inside `orgId` (file library spec §2, §5): a library
 * file referred to (`conversation_files`) by the conversation, by its root, or by a sub-agent
 * conversation below the conversation (so a parent reaches an image its sub-agent's tool returned;
 * tool result images design §5), else a `read` copy bound to one of them (this lookup is the
 * model's, vision-read design §1.1). Anything else (a library file the person never attached, a
 * sibling's or another tree's, another org's, a deleted file, bytes gone or replaced, an id that is
 * not a UUID) is `null`. Storage errors are thrown as they are. `signal` aborts the storage reads.
 */
export async function findConversationFile(
  deps: ConversationFileDeps,
  q: {
    orgId: string;
    conversationId: string;
    rootConversationId: string;
    id: string;
    /** The most bytes {@link ConversationFile.open} may be asked for (a range read). */
    maxBytes?: number;
    signal?: AbortSignal;
  },
): Promise<ConversationFile | null> {
  if (!UUID.test(q.id)) return null;
  const id = q.id.toLowerCase();
  const conversations = [...new Set([q.conversationId, q.rootConversationId])];
  // a file of a sub-agent below the calling conversation joins the lookup
  const owners = await ownersOf(deps, q.orgId, id);
  for (const owner of owners.conversationIds) {
    if (
      !conversations.includes(owner) &&
      (await isBelow(deps.db, q.orgId, owner, q.conversationId))
    ) {
      conversations.push(owner);
    }
  }

  const files = deps.files;
  const [file] = files ? await files.referenced(q.orgId, conversations, [id]) : [];
  if (files && file !== undefined) {
    const max = q.maxBytes;
    // only a larger object is ranged (a range on an empty object is unsatisfiable)
    const got = await files.open(q.orgId, file, {
      ...(q.signal !== undefined && { signal: q.signal }),
      ...(max !== undefined && file.blob.size > max && { range: { start: 0, end: max - 1 } }),
    });
    if (got === null) return null;
    return {
      kind: file.origin === "upload" ? "attachment" : "artifact",
      id,
      name: file.name,
      contentType: file.contentType,
      size: file.blob.size,
      // the one storage read of the lookup: its stream is read by open() or cancelled by discard()
      open: (opts) => bytesOf(got.body, opts?.maxBytes),
      discard: () => got.body.cancel().catch(() => {}),
    };
  }
  if (!owners.readCopy) return null;

  for (const conversationId of conversations) {
    const opened = await deps.attachments.openForConversation(q.orgId, conversationId, id, {
      ...(q.maxBytes !== undefined && { maxBytes: q.maxBytes }),
      ...(q.signal !== undefined && { signal: q.signal }),
    });
    if (opened === null) continue;
    return {
      kind: "attachment",
      id,
      readCopyOf: conversationId,
      name: opened.name,
      contentType: opened.contentType,
      size: opened.size,
      open: (opts) => bytesOf(opened.body, opts?.maxBytes),
      discard: () => opened.body.cancel().catch(() => {}),
    };
  }
  return null;
}
