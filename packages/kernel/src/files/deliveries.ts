import { Inject, Injectable } from "@nestjs/common";
import { type AppendEvent, EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { type BlobRow, BlobsService } from "./blobs.service.js";

/** One delivered file to record: its file id is the artifact id of its `artifact_created` event. */
export interface DeliveredFileRow {
  id: string;
  blobId: string;
  name: string;
  contentType: string;
  size: number;
  origin: "delivered" | "generated";
  sourcePath: string;
  /** The seq of the event that delivered it. */
  firstSeq: number;
}

/**
 * A blob a delivery wanted to reference was no longer `ready` when its transaction locked it (a
 * deletion claimed it after {@link BlobsService.ensureFromBytes} returned it). The transaction
 * rolls back; the caller ensures the bytes again and retries.
 */
export class DeliveryBlobGoneError extends Error {
  constructor(readonly blobId: string) {
    super(`blob ${blobId} is no longer ready`);
    this.name = "DeliveryBlobGoneError";
  }
}

/**
 * Deliveries into the file library (file library spec §4 "Delivering"): the bytes of a delivered
 * or generated file become a shared blob of the org ({@link ensureBlob}, intent first, reused by
 * hash), then the `artifact_created` events and their `files` / `conversation_files` rows commit
 * in one transaction ({@link appendDelivered}). The owner of a delivered file is the
 * conversation's owner, its agent the conversation's agent. No process state.
 */
@Injectable()
export class FileDeliveries {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(BlobsService)
    private readonly blobs: Pick<BlobsService, "ensureFromBytes" | "lockReady">,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "appendInReport" | "notify">,
  ) {}

  /**
   * The ready blob holding `bytes` (hex `sha256`): an existing one of the org, else a new one
   * written intent first ({@link BlobsService.ensureFromBytes}). Unlocked: the transaction that
   * references it locks it ({@link recordDelivered}).
   */
  ensureBlob(
    orgId: string,
    sha256: string,
    bytes: Uint8Array,
    opts: { contentType: string; signal?: AbortSignal },
  ): Promise<BlobRow> {
    return this.blobs.ensureFromBytes(orgId, sha256, bytes, opts);
  }

  /**
   * Appends `events` to the conversation's log and records the delivered file of every event this
   * call wrote (`files[i]` belongs to `events[i]`; an event returned by its idempotency key, a
   * parallel call's, records nothing), all in one transaction; announces the log after the commit.
   * Throws {@link DeliveryBlobGoneError} (nothing written) when a blob is no longer ready.
   */
  async appendDelivered(
    orgId: string,
    conversationId: string,
    events: AppendEvent[],
    files: readonly Omit<DeliveredFileRow, "firstSeq">[],
  ): Promise<ConversationEvent[]> {
    const { events: out, toSeq } = await this.appendDeliveredIn(
      orgId,
      conversationId,
      events,
      files,
    );
    if (toSeq !== null) await this.eventLog.notify(conversationId, toSeq);
    return out;
  }

  // shared admission as the log's own appends (a tool step's are still admitted exclusively):
  // nothing here takes an org-level lock
  @Transactional({ propagation: "requires_new", admission: "shared" })
  private async appendDeliveredIn(
    orgId: string,
    conversationId: string,
    events: AppendEvent[],
    files: readonly Omit<DeliveredFileRow, "firstSeq">[],
  ): Promise<{ events: ConversationEvent[]; toSeq: number | null }> {
    const { events: out, fresh } = await this.eventLog.appendInReport(conversationId, events);
    const rows: DeliveredFileRow[] = [];
    let toSeq: number | null = null;
    for (const [i, ev] of out.entries()) {
      if (!fresh[i]) continue;
      toSeq = Math.max(toSeq ?? 0, ev.seq);
      const f = files[i];
      if (f !== undefined) rows.push({ ...f, firstSeq: ev.seq });
    }
    await this.recordDelivered(orgId, conversationId, rows);
    return { events: out, toSeq };
  }

  /**
   * In the caller's transaction: locks every row's blob ({@link BlobsService.lockReady}, the gate
   * of a new reference) and inserts the `files` rows (owner and agent the conversation's, status
   * `ready`) and their `conversation_files` rows (`delivered`); idempotent by id. Throws
   * {@link DeliveryBlobGoneError} when a blob is no longer ready.
   */
  @Transactional({ propagation: "mandatory" })
  async recordDelivered(
    orgId: string,
    conversationId: string,
    rows: readonly DeliveredFileRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const locked = new Map<string, BlobRow>();
    for (const blobId of new Set(rows.map((r) => r.blobId))) {
      const blob = await this.blobs.lockReady(orgId, blobId);
      if (blob === null) throw new DeliveryBlobGoneError(blobId);
      locked.set(blobId, blob);
    }
    const trx = this.db.db;
    const conv = await trx
      .selectFrom("conversations")
      .select(["account_id", "agent_id"])
      .where("id", "=", conversationId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!conv) throw new Error(`conversation ${conversationId} not found in its org`);
    await trx
      .insertInto("files")
      .values(
        rows.map((r) => ({
          id: r.id,
          org_id: orgId,
          account_id: conv.account_id,
          blob_id: r.blobId,
          name: r.name,
          content_type: r.contentType,
          size: r.size,
          origin: r.origin,
          status: "ready" as const,
          agent_id: conv.agent_id,
          source_conversation_id: conversationId,
          source_path: r.sourcePath,
          // the reference the model may see stays this blob's after a later merge
          ref_key: locked.get(r.blobId)?.objectKey ?? null,
          ref_etag: locked.get(r.blobId)?.etag ?? null,
        })),
      )
      .onConflict((oc) => oc.column("id").doNothing())
      .execute();
    await trx
      .insertInto("conversation_files")
      .values(
        rows.map((r) => ({
          conversation_id: conversationId,
          file_id: r.id,
          org_id: orgId,
          role: "delivered" as const,
          first_seq: r.firstSeq,
        })),
      )
      .onConflict((oc) => oc.columns(["conversation_id", "file_id"]).doNothing())
      .execute();
  }
}
