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
  /** Reads the bytes (the lookup itself holds no open stream). */
  open(): Promise<Uint8Array>;
}

export interface ConversationFileDeps {
  db: Pick<KernelDb, "selectFrom">;
  attachments: Pick<AttachmentsService, "openForConversation">;
  storage: Pick<StorageService, "kernel">;
}

/** Lower-case or upper-case UUIDs: attachment and artifact ids. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bytesOf = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(body).arrayBuffer());

/**
 * A file of the conversation by id, always inside `orgId`: an attachment bound to the
 * conversation or to its root, else an `artifact_created` event of either. Anything else (another
 * conversation or org, a missing object, an id that is not a UUID) is `null`. Storage errors are
 * thrown as they are.
 */
export async function findConversationFile(
  deps: ConversationFileDeps,
  q: { orgId: string; conversationId: string; rootConversationId: string; id: string },
): Promise<ConversationFile | null> {
  if (!UUID.test(q.id)) return null;
  const id = q.id.toLowerCase();
  const conversations = [...new Set([q.conversationId, q.rootConversationId])];

  for (const conversationId of conversations) {
    const opened = await deps.attachments.openForConversation(q.orgId, conversationId, id);
    if (opened === null) continue;
    // only the facts are needed now; the bytes are fetched again by open()
    await opened.body.cancel().catch(() => {});
    return {
      kind: "attachment",
      id,
      name: opened.name,
      contentType: opened.contentType,
      size: opened.size,
      async open() {
        const again = await deps.attachments.openForConversation(q.orgId, conversationId, id);
        if (again === null) throw new Error(`attachment ${id} is no longer available`);
        return bytesOf(again.body);
      },
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
    async open() {
      const got = await store.get(a.objectKey);
      if (got === null) throw new Error(`artifact ${id} is no longer available`);
      return bytesOf(got.body);
    },
  };
}
