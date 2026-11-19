import { sql } from "kysely";
import type { AttachmentsService } from "../../conversations/attachments.service.js";
import type { EventPayload } from "../../conversations/events.js";
import type { KernelDb } from "../../infra/database/kernel-db.js";
import type { StorageService } from "../../storage/storage.service.js";

/** An id of the conversation's files: an attachment or an artifact (generated or delivered). */
export interface ConversationFile {
  kind: "attachment" | "artifact";
  id: string;
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

/**
 * A file of the conversation by id, always inside `orgId`: an attachment bound to the
 * conversation or to its root (a `chat` attachment or a `read` copy: this lookup is the model's,
 * vision-read design §1.1), else an `artifact_created` event of either. Anything else (another
 * conversation or org, a missing object, an id that is not a UUID) is `null`. Storage errors are
 * thrown as they are. `signal` aborts the storage reads.
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
