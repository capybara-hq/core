import { sql } from "kysely";
import type { AttachmentsService } from "../../conversations/attachments.service.js";
import type { EventPayload } from "../../conversations/events.js";
import type { KernelDb } from "../../infra/database/kernel-db.js";
import type { StorageService } from "../../storage/storage.service.js";

/** An id of the conversation's files: an attachment or an artifact (generated or delivered). */
export interface ConversationFile {
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
   * Reads the bytes, at most `maxBytes` of them when given (the head of a larger file: an
   * attachment's stream is cancelled there, an artifact is read with a range). Call it, or
   * {@link discard}, exactly once: an attachment holds its stream.
   */
  open(opts?: { maxBytes?: number }): Promise<Uint8Array>;
  /** Releases the file without reading it (a refusal before the bytes are needed). */
  discard(): Promise<void>;
}

export interface ConversationFileDeps {
  db: Pick<KernelDb, "selectFrom">;
  attachments: Pick<AttachmentsService, "openForConversation">;
  storage: Pick<StorageService, "kernel">;
}

/** Lower-case or upper-case UUIDs: attachment and artifact ids. */
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
 * The conversation an attachment (`chat` or `read`, ready) or artifact with this id belongs to,
 * in `orgId`; null when there is none.
 */
async function ownerOf(
  db: ConversationFileDeps["db"],
  orgId: string,
  id: string,
): Promise<{ conversationId: string; purpose: string } | null> {
  const att = await db
    .selectFrom("attachments")
    .select(["conversation_id", "purpose"])
    .where("id", "=", id)
    .where("org_id", "=", orgId)
    .where("status", "=", "ready")
    .where("purpose", "in", ["chat", "read"])
    .executeTakeFirst();
  if (att?.conversation_id) return { conversationId: att.conversation_id, purpose: att.purpose };
  const ev = await db
    .selectFrom("conversation_events as e")
    .innerJoin("conversations as c", "c.id", "e.conversation_id")
    .select("e.conversation_id")
    .where("c.org_id", "=", orgId)
    .where("e.type", "=", "artifact_created")
    .where(sql<string>`e.payload->>'artifactId'`, "=", id)
    .limit(1)
    .executeTakeFirst();
  return ev ? { conversationId: ev.conversation_id, purpose: "artifact" } : null;
}

/**
 * A file of the conversation by id, always inside `orgId`: an attachment (a `chat` attachment or
 * a `read` copy: this lookup is the model's, vision-read design §1.1) or an `artifact_created`
 * event of the conversation, of its root, or of a sub-agent conversation below the conversation
 * (so a parent reaches an image its sub-agent's tool returned; tool result images design §5).
 * Anything else (a sibling's or another tree's, another org's, a missing object, an id that is
 * not a UUID) is `null`. Storage errors are thrown as they are. `signal` aborts the storage reads.
 */
export async function findConversationFile(
  deps: ConversationFileDeps,
  q: {
    orgId: string;
    conversationId: string;
    rootConversationId: string;
    id: string;
    /** The most bytes {@link ConversationFile.open} may be asked for (an attachment's range). */
    maxBytes?: number;
    signal?: AbortSignal;
  },
): Promise<ConversationFile | null> {
  if (!UUID.test(q.id)) return null;
  const id = q.id.toLowerCase();
  const conversations = [...new Set([q.conversationId, q.rootConversationId])];
  // a file of a sub-agent below the calling conversation joins the lookup
  const found = await ownerOf(deps.db, q.orgId, id);
  const owner = found?.conversationId;
  if (
    owner !== undefined &&
    !conversations.includes(owner) &&
    (await isBelow(deps.db, q.orgId, owner, q.conversationId))
  ) {
    conversations.push(owner);
  }

  for (const conversationId of conversations) {
    const opened = await deps.attachments.openForConversation(q.orgId, conversationId, id, {
      purposes: ["chat", "read"],
      ...(q.maxBytes !== undefined && { maxBytes: q.maxBytes }),
      ...(q.signal !== undefined && { signal: q.signal }),
    });
    if (opened === null) continue;
    return {
      kind: "attachment",
      id,
      ...(found?.purpose === "read" && owner === conversationId && { readCopyOf: conversationId }),
      name: opened.name,
      contentType: opened.contentType,
      size: opened.size,
      // the one storage read of the lookup: its stream is read by open() or cancelled by discard()
      open: (opts) => bytesOf(opened.body, opts?.maxBytes),
      discard: () => opened.body.cancel().catch(() => {}),
    };
  }

  const row = await deps.db
    .selectFrom("conversation_events as e")
    .innerJoin("conversations as c", "c.id", "e.conversation_id")
    .select("e.payload")
    .where("c.org_id", "=", q.orgId)
    .where("e.conversation_id", "in", conversations)
    .where("e.type", "=", "artifact_created")
    .where(sql<string>`e.payload->>'artifactId'`, "=", id)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const a = row.payload as EventPayload<"artifact_created">;
  const store = deps.storage.kernel(q.orgId);
  const head = await store.head(a.objectKey);
  if (head === null) return null;
  return {
    kind: "artifact",
    id,
    name: a.name,
    contentType: a.contentType,
    size: head.size,
    async open(opts) {
      const max = opts?.maxBytes;
      // only a larger object is ranged (a range on an empty object is unsatisfiable)
      const ranged = max !== undefined && head.size > max;
      const got = await store.get(a.objectKey, {
        ...(q.signal !== undefined && { signal: q.signal }),
        ...(ranged && { range: { start: 0, end: max - 1 } }),
      });
      if (got === null) throw new Error(`artifact ${id} is no longer available`);
      return bytesOf(got.body, max);
    },
    discard: async () => {},
  };
}
