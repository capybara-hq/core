import { createHash, randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { findRepeat } from "../../conversations/delivery-scope.js";
import type { AppendEvent, EventLog } from "../../conversations/event-log.js";
import type { ConversationEvent } from "../../conversations/events.js";
import { isStorageUnavailable, type StorageService } from "../../storage/storage.service.js";
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
  storage: Pick<StorageService, "kernel">;
  eventLog: Pick<EventLog, "append" | "readDeliveryScope"> &
    Partial<Pick<EventLog, "publishChanged">>;
}

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
 * Stores `files` as artifacts of the call's conversation, all or none: every object is uploaded
 * under the kernel prefix (`artifacts/<conversationId>/<artifactId>`), then all their
 * `artifact_created` events (the call's run and `callId`, the bytes' sha256) go into the log in
 * one append. Any failure, an abort of the call before the append included, deletes every object
 * uploaded so far (best effort; one left behind is unreferenced and goes with the conversation's
 * purge) and rethrows; a store that is not there is the {@link NO_STORAGE} tool error. The
 * conversation's files are announced changed once, when something new was stored.
 *
 * With a run, the same bytes reach the user once per delivery scope (truthful delivery spec §2):
 * a file equal to an earlier file of the call, or a repeat by {@link findRepeat} of the scope's
 * artifacts, is not uploaded and comes back with `repeatOf`. Each event's idempotency key is
 * `artifact:<runId>:<boundary>:<sha256>:<lastOfSource>`, so two parallel calls that both saw no
 * repeat compute the same key: the append's row lock and the unique key give the second the
 * first's event, and the one cleanup rule deletes every object whose returned event is not the
 * one generated for it, making that file a repeat of the returned event. No process state.
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
  const uploaded: string[] = [];
  /** The inputs written as events, in the order of `events`, with their generated ids. */
  const written: { index: number; artifactId: string; objectKey: string }[] = [];
  const events: AppendEvent[] = [];
  let stored: ConversationEvent[] = [];
  try {
    const scope =
      ctx.runId === undefined
        ? null
        : await deps.eventLog.readDeliveryScope(ctx.conversationId, ctx.runId);
    const store = deps.storage.kernel(ctx.orgId);
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
      const objectKey = `artifacts/${ctx.conversationId}/${artifactId}`;
      await store.put(objectKey, f.data, {
        contentType: f.contentType,
        size: f.data.byteLength,
        signal: ctx.signal,
      });
      uploaded.push(objectKey);
      written.push({ index: i, artifactId, objectKey });
      events.push({
        type: "artifact_created",
        ...(ctx.runId !== undefined && { runId: ctx.runId }),
        ...(idemKey !== undefined && { idemKey }),
        payload: {
          artifactId,
          name: f.name,
          contentType: f.contentType,
          size: f.data.byteLength,
          objectKey,
          sourcePath: f.sourcePath,
          callId: ctx.callId,
          sha256,
        },
      });
      out[i] = { artifactId, name: f.name, size: f.data.byteLength };
    }
    // a call stopped while uploading writes no event: its objects are removed below
    ctx.signal.throwIfAborted();
    if (events.length > 0) stored = await deps.eventLog.append(ctx.conversationId, events);
  } catch (e) {
    // no event references them: remove what was uploaded (best effort)
    await removeObjects(deps, ctx, uploaded);
    if (isStorageUnavailable(e)) throw new ToolError(NO_STORAGE);
    throw e;
  }
  // the one cleanup rule: an event that is not the one generated (a parallel call appended the
  // same key first) leaves this upload unreferenced, and the file repeats that event
  const unused: string[] = [];
  let fresh = false;
  for (const [j, w] of written.entries()) {
    const ev = stored[j];
    const payload = ev?.type === "artifact_created" ? ev.payload : undefined;
    if (payload === undefined || payload.artifactId === w.artifactId) {
      fresh = true;
      continue;
    }
    unused.push(w.objectKey);
    setRepeat(out, w.index, payload);
  }
  await removeObjects(deps, ctx, unused);
  // a file equal to an earlier one of the call repeats whatever that one became
  for (const [i, first] of firstOf.entries()) {
    if (first === i) continue;
    const prior = out[first] as StoredArtifact;
    setRepeat(out, i, prior.repeatOf ?? prior);
  }
  if (fresh) await deps.eventLog.publishChanged?.(ctx.conversationId, "files");
  return out;
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

/** Deletes `keys` from the org's kernel store, best effort (a failure leaves an orphan object). */
async function removeObjects(
  deps: ArtifactStoreDeps,
  ctx: BuiltinCallContext,
  keys: readonly string[],
): Promise<void> {
  await Promise.all(
    keys.map((key) =>
      Promise.resolve()
        .then(() => deps.storage.kernel(ctx.orgId).delete(key))
        .catch(() => {}),
    ),
  );
}
