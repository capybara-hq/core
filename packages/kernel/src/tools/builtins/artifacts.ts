import { createHash, randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { findRepeat } from "../../conversations/delivery-scope.js";
import type { AppendEvent, EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent } from "../../conversations/events.js";
import type { BlobRow } from "../../files/blobs.service.js";
import { DeliveryBlobGoneError, type FileDeliveries } from "../../files/deliveries.js";
import { isStorageUnavailable } from "../../storage/storage.service.js";
import type { BuiltinCallContext } from "../registry.js";

/**
 * The tool error when the deployment has no object store (or it went away): files cannot be
 * delivered. `Deliver` and `GenerateImage` share it.
 */
export const NO_STORAGE =
  "File storage is not configured in this deployment, so files cannot be delivered; ask an administrator, or provide the result in your reply instead.";
/** The same as the "tool unavailable" reason (the kernel adds the final period). */
export const NO_STORAGE_REASON = NO_STORAGE.slice(0, -1);

/** What {@link storeArtifacts} needs. */
export interface ArtifactStoreDeps {
  eventLog: Pick<EventLog, "readDeliveryScope"> & Partial<Pick<EventLog, "publishChanged">>;
  /**
   * The blobs and the one transaction of a delivery (file library spec §4). Absent in test stubs
   * without a store: nothing can be delivered then ({@link NO_STORAGE}).
   */
  deliveries?: Pick<FileDeliveries, "ensureBlob" | "appendDelivered"> | undefined;
}

/** How often a delivery whose blob was claimed by a deletion meanwhile is tried again. */
const BLOB_ATTEMPTS = 3;

/** One file to deliver as an artifact. */
export interface ArtifactFile {
  /** The name shown to the user (already checked with `isValidArtifactName`). */
  name: string;
  contentType: string;
  data: Uint8Array;
  /**
   * Where the file came from, which groups deliveries into versions in the conversation's files:
   * the device path for `Deliver`, `generated/<callId>/<name>` for a generated file.
   */
  sourcePath: string;
}

/**
 * A stored artifact as the tool result names it. For a repeat (`repeatOf` set: the same bytes
 * were already delivered in this delivery scope) nothing was stored and `artifactId` is the
 * earlier artifact's.
 */
export interface StoredArtifact {
  artifactId: string;
  name: string;
  size: number;
  repeatOf?: { artifactId: string; name: string };
}

/** The clause that says a file repeats an artifact already delivered in the scope. */
export const REPEAT_CLAUSE = (prior: { name: string; artifactId: string }): string =>
  `same content as ${prior.name} (artifact ${prior.artifactId}), already delivered to the user since the person last spoke; no new artifact was created.`;

/** The result text of a file that repeats an artifact already delivered in the scope. */
export const REPEAT_TEXT = (name: string, prior: { name: string; artifactId: string }): string =>
  `${name} has the ${REPEAT_CLAUSE(prior)}`;

/**
 * Stores `files` as artifacts of the call's conversation, all or none (file library spec §4): the
 * bytes of every file become a ready blob of the org ({@link FileDeliveries.ensureBlob}: an
 * existing blob of the same sha256 is reused with no upload, else a new one is written intent
 * first), then all their `artifact_created` events (the call's run and `callId`, the bytes'
 * sha256, `fileId` = the artifact id, `objectKey` = the blob's key) and their files (owner the
 * conversation's owner, origin `generated` for a `generated/` source path, else `delivered`) are
 * written in one transaction. A blob a deletion claimed in between aborts that transaction, and
 * the bytes are ensured again and the whole unit retried (a bounded number of times). Nothing is
 * cleaned up on failure: a blob may serve other files, and an unreferenced one is the blob sweep's.
 * A store that is not there is the {@link NO_STORAGE} tool error. The conversation's files are
 * announced changed once, when something new was stored.
 *
 * With a run, the same bytes reach the user once per delivery scope (truthful delivery spec §2):
 * a file equal to an earlier file of the call, or a repeat by {@link findRepeat} of the scope's
 * artifacts, is not stored and comes back with `repeatOf`. Each event's idempotency key is
 * `artifact:<runId>:<boundary>:<sha256>:<lastOfSource>`, so two parallel calls that both saw no
 * repeat compute the same key: the append's row lock and the unique key give the second the
 * first's event (and record no file for it), making that file a repeat of the returned event.
 * No process state.
 */
export async function storeArtifacts(
  deps: ArtifactStoreDeps,
  ctx: BuiltinCallContext,
  files: readonly ArtifactFile[],
): Promise<StoredArtifact[]> {
  const hashes = files.map((f) => createHash("sha256").update(f.data).digest("hex"));
  const out: StoredArtifact[] = files.map((f) => ({
    artifactId: "",
    name: f.name,
    size: f.data.byteLength,
  }));
  /** Per input: the earlier input of the same call it repeats (with a run), else itself. */
  const firstOf = hashes.map((h, i) => (ctx.runId === undefined ? i : hashes.indexOf(h)));
  /** The inputs to write as events, in event order, with their generated ids and blobs. */
  const written: { index: number; artifactId: string; idemKey?: string; blob: BlobRow }[] = [];
  let stored: ConversationEvent[] = [];
  try {
    const deliveries = deps.deliveries;
    if (deliveries === undefined) throw new ToolError(NO_STORAGE);
    const scope =
      ctx.runId === undefined
        ? null
        : await deps.eventLog.readDeliveryScope(ctx.conversationId, ctx.runId);
    const ensure = (i: number) => {
      const f = files[i] as ArtifactFile;
      return deliveries.ensureBlob(ctx.orgId, hashes[i] as string, f.data, {
        contentType: f.contentType,
        signal: ctx.signal,
      });
    };
    for (const [i, f] of files.entries()) {
      if (firstOf[i] !== i) continue;
      const sha256 = hashes[i] as string;
      let idemKey: string | undefined;
      if (scope !== null) {
        const { repeatOf, lastOfSource } = findRepeat(scope, sha256, f.sourcePath);
        if (repeatOf !== null) {
          setRepeat(out, i, repeatOf);
          continue;
        }
        idemKey = `artifact:${ctx.runId}:${scope.boundary}:${sha256}:${lastOfSource}`;
      }
      const artifactId = randomUUID();
      written.push({
        index: i,
        artifactId,
        ...(idemKey !== undefined && { idemKey }),
        blob: await ensure(i),
      });
      out[i] = { artifactId, name: f.name, size: f.data.byteLength };
    }
    // a call stopped while storing writes no event (its blobs are shared or the sweep's)
    ctx.signal.throwIfAborted();
    for (let attempt = 1; written.length > 0; attempt++) {
      try {
        stored = await deliveries.appendDelivered(
          ctx.orgId,
          ctx.conversationId,
          written.map((w) => artifactEvent(ctx, files[w.index] as ArtifactFile, w, hashes)),
          written.map((w) => {
            const f = files[w.index] as ArtifactFile;
            return {
              id: w.artifactId,
              blobId: w.blob.id,
              name: f.name,
              contentType: f.contentType,
              size: f.data.byteLength,
              origin: f.sourcePath.startsWith("generated/") ? "generated" : "delivered",
              sourcePath: f.sourcePath,
            };
          }),
        );
        break;
      } catch (e) {
        if (!(e instanceof DeliveryBlobGoneError) || attempt >= BLOB_ATTEMPTS) throw e;
        // a deletion claimed the blob after it was ensured: ensure those bytes again
        for (const w of written) {
          if (w.blob.id === e.blobId) w.blob = await ensure(w.index);
        }
        ctx.signal.throwIfAborted();
      }
    }
  } catch (e) {
    if (isStorageUnavailable(e)) throw new ToolError(NO_STORAGE);
    throw e;
  }
  // an event that is not the one generated (a parallel call appended the same key first): the
  // file repeats that event
  let fresh = false;
  for (const [j, w] of written.entries()) {
    const ev = stored[j];
    const payload = ev?.type === "artifact_created" ? ev.payload : undefined;
    if (payload === undefined || payload.artifactId === w.artifactId) {
      fresh = true;
      continue;
    }
    setRepeat(out, w.index, payload);
  }
  // a file equal to an earlier one of the call repeats whatever that one became
  for (const [i, first] of firstOf.entries()) {
    if (first === i) continue;
    const prior = out[first] as StoredArtifact;
    setRepeat(out, i, prior.repeatOf ?? prior);
  }
  if (fresh) await deps.eventLog.publishChanged?.(ctx.conversationId, "files");
  return out;
}

/** The `artifact_created` event of one written file. */
function artifactEvent(
  ctx: BuiltinCallContext,
  f: ArtifactFile,
  w: { index: number; artifactId: string; idemKey?: string; blob: BlobRow },
  hashes: readonly string[],
): AppendEvent {
  return {
    type: "artifact_created",
    ...(ctx.runId !== undefined && { runId: ctx.runId }),
    ...(w.idemKey !== undefined && { idemKey: w.idemKey }),
    payload: {
      artifactId: w.artifactId,
      fileId: w.artifactId,
      name: f.name,
      contentType: f.contentType,
      size: f.data.byteLength,
      objectKey: w.blob.objectKey,
      sourcePath: f.sourcePath,
      callId: ctx.callId,
      sha256: hashes[w.index] as string,
    },
  };
}

function setRepeat(
  out: StoredArtifact[],
  i: number,
  prior: { artifactId: string; name: string },
): void {
  const cur = out[i] as StoredArtifact;
  out[i] = {
    artifactId: prior.artifactId,
    name: cur.name,
    size: cur.size,
    repeatOf: { artifactId: prior.artifactId, name: prior.name },
  };
}
