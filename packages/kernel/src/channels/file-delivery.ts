import { asCode, type Channel, IMAGE_MEDIA_TYPES, type ObjectStore } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent } from "../conversations/events.js";
import { isStorageUnavailable } from "../storage/storage.service.js";
import { conversationUrl } from "./cards.js";
import { type ChannelLocale, phrase } from "./phrases.js";

type ArtifactPayload = Extract<ConversationEvent, { type: "artifact_created" }>["payload"];

/** How one conversation file reaches an IM chat. */
export type FileDeliveryPlan =
  | { mode: "native"; kind: "image" | "file"; cap: number }
  | { mode: "link"; reason: "unsupported" | "disabled" | "too_large" | "empty" | "foreign_key" };

/**
 * Decides native upload or a link line for one artifact. Order: a key outside the conversation's
 * `artifacts/<conversationId>/` prefix, an empty file, a channel without `sendFile`, the deployment
 * switch (`fileMaxBytes` 0), then the size cap (the smaller of the channel's and the deployment's).
 */
export function planFileDelivery(input: {
  conversationId: string;
  artifact: Pick<ArtifactPayload, "objectKey" | "size" | "contentType">;
  features: Channel["features"];
  canSendFile: boolean;
  fileMaxBytes: number;
}): FileDeliveryPlan {
  const { artifact, features, fileMaxBytes } = input;
  if (!artifact.objectKey.startsWith(`artifacts/${input.conversationId}/`)) {
    return { mode: "link", reason: "foreign_key" };
  }
  if (artifact.size === 0) return { mode: "link", reason: "empty" };
  const files = features.files;
  if (!input.canSendFile || !validFiles(files)) return { mode: "link", reason: "unsupported" };
  if (fileMaxBytes === 0) return { mode: "link", reason: "disabled" };
  const cap = Math.min(files.maxBytes, fileMaxBytes);
  if (artifact.size > cap) return { mode: "link", reason: "too_large" };
  return { mode: "native", kind: fileKind(artifact.contentType, artifact.size, files), cap };
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** A declaration with a finite positive `maxBytes`; anything else is no native file support. */
function validFiles(files: Channel["features"]["files"]): files is NonNullable<typeof files> {
  return files !== undefined && positive(files.maxBytes);
}

/** An image iff the content type is a supported raster type and the size fits the image limit. */
export function fileKind(
  contentType: string,
  size: number,
  files: NonNullable<Channel["features"]["files"]>,
): "image" | "file" {
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  const isImage = (IMAGE_MEDIA_TYPES as readonly string[]).includes(type);
  return isImage && size <= (positive(files.imageMaxBytes) ? files.imageMaxBytes : files.maxBytes)
    ? "image"
    : "file";
}

const MAX_PLUGIN_FILE_NAME = 200;

/**
 * The name handed to a plugin: the model chooses file names, so control characters become spaces
 * and path separators `_`, the length is capped, and an empty result is `file`. The link and root
 * lines show the original name (through `asCode`).
 */
export function pluginFileName(name: string): string {
  const clean = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/[\\/]/g, "_")
    .trim();
  const capped = Array.from(clean).slice(0, MAX_PLUGIN_FILE_NAME).join("").trim();
  return capped === "" ? "file" : capped;
}

/** `512 B`, `1.5 KB`, `2.3 MB`, `1.0 GB` (1024-based). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  // A value that rounds up to 1024.0 is shown in the next unit
  while (Number(v.toFixed(1)) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function fill(template: string, values: Record<"name" | "size" | "url", string>): string {
  return template.replace(/\{(name|size|url)\}/g, (_, k: "name" | "size" | "url") => values[k]);
}

/** The one line that stands in for a file that is not sent natively. */
export function fileLinkText(input: {
  name: string;
  size: number;
  artifactId: string;
  conversationId: string;
  base: string | undefined;
  locale: ChannelLocale;
}): string {
  const name = asCode(input.name);
  const size = formatFileSize(input.size);
  if (input.base === undefined) {
    return fill(phrase("fileOnWebNoLink", input.locale), { name, size, url: "" });
  }
  const url = `${conversationUrl(input.base, input.conversationId)}#file=${input.artifactId}`;
  return fill(phrase("fileOnWeb", input.locale), { name, size, url });
}

/** The root message text of a native file delivery. */
export function fileRootText(name: string, locale: ChannelLocale): string {
  return fill(phrase("fileRoot", locale), { name: asCode(name), size: "", url: "" });
}

export type CappedRead =
  | { kind: "ok"; data: Uint8Array }
  | { kind: "missing" }
  | { kind: "too_large" }
  | { kind: "unavailable" };

/**
 * Reads an object into memory, never more than `cap` bytes: a larger head, or a body that passes
 * `cap` while streaming, is `too_large` (the body is cancelled). A missing object is `missing`, a
 * store that is not there `unavailable`; any other error is rethrown (retryable).
 */
export async function readArtifactCapped(
  store: ObjectStore,
  key: string,
  cap: number,
  signal: AbortSignal,
): Promise<CappedRead> {
  try {
    const got = await store.get(key, { signal });
    if (got === null) return { kind: "missing" };
    const reader = got.body.getReader();
    try {
      if (got.head.size > cap) return { kind: "too_large" };
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > cap) return { kind: "too_large" };
        chunks.push(value);
      }
      const data = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        data.set(c, off);
        off += c.length;
      }
      return { kind: "ok", data };
    } finally {
      // A no-op after a complete read; cancels the body on every early exit and on a failed read
      await reader.cancel().catch(() => undefined);
    }
  } catch (e) {
    if (isStorageUnavailable(e)) return { kind: "unavailable" };
    throw e;
  }
}

/** A counting semaphore with a FIFO of waiters; one per worker replica (not a provider). */
export class FileSlots {
  private free: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.free = limit;
  }

  /** Resolves with a release function; rejects with `signal.reason` when aborted while waiting. */
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.free > 0) {
      this.free--;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(wake);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(signal.reason);
      };
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(wake);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    };
  }
}
