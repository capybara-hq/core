import { randomUUID } from "node:crypto";
import { ToolError } from "@capybara-hq/plugin-sdk";
import type { AppendEvent, EventLog } from "../../conversations/event-log.js";
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
  eventLog: Pick<EventLog, "append"> & Partial<Pick<EventLog, "publishChanged">>;
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

/** A stored artifact as the tool result names it. */
export interface StoredArtifact {
  artifactId: string;
  name: string;
  size: number;
}

/**
 * Stores `files` as artifacts of the call's conversation, all or none: every object is uploaded
 * under the kernel prefix (`artifacts/<conversationId>/<artifactId>`), then all their
 * `artifact_created` events (the call's run and `callId`) go into the log in one append. Any
 * failure, an abort of the call before the append included, deletes every object uploaded so far
 * (best effort; one left behind is unreferenced and goes with the conversation's purge) and
 * rethrows; a store that is not there is the {@link NO_STORAGE} tool error. The conversation's
 * files are announced changed once.
 */
export async function storeArtifacts(
  deps: ArtifactStoreDeps,
  ctx: BuiltinCallContext,
  files: readonly ArtifactFile[],
): Promise<StoredArtifact[]> {
  const uploaded: string[] = [];
  const events: AppendEvent[] = [];
  const out: StoredArtifact[] = [];
  try {
    const store = deps.storage.kernel(ctx.orgId);
    for (const f of files) {
      const artifactId = randomUUID();
      const objectKey = `artifacts/${ctx.conversationId}/${artifactId}`;
      await store.put(objectKey, f.data, {
        contentType: f.contentType,
        size: f.data.byteLength,
        signal: ctx.signal,
      });
      uploaded.push(objectKey);
      events.push({
        type: "artifact_created",
        ...(ctx.runId !== undefined && { runId: ctx.runId }),
        payload: {
          artifactId,
          name: f.name,
          contentType: f.contentType,
          size: f.data.byteLength,
          objectKey,
          sourcePath: f.sourcePath,
          callId: ctx.callId,
        },
      });
      out.push({ artifactId, name: f.name, size: f.data.byteLength });
    }
    // a call stopped while uploading writes no event: its objects are removed below
    ctx.signal.throwIfAborted();
    await deps.eventLog.append(ctx.conversationId, events);
  } catch (e) {
    // no event references them: remove what was uploaded (best effort)
    await Promise.all(
      uploaded.map((key) =>
        Promise.resolve()
          .then(() => deps.storage.kernel(ctx.orgId).delete(key))
          .catch(() => {}),
      ),
    );
    if (isStorageUnavailable(e)) throw new ToolError(NO_STORAGE);
    throw e;
  }
  await deps.eventLog.publishChanged?.(ctx.conversationId, "files");
  return out;
}
