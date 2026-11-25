import { MEDIA_LIMITS } from "@capybara-hq/plugin-sdk";
import { sniffImage } from "../media/image-header.js";
import { sizeText } from "./builtins/size-text.js";
import type { ToolResultMedia } from "./registry.js";

/**
 * Images in tool results (tool result images design §2): the pipeline stores every image block a
 * tool returns as a `read` copy of the calling conversation and names it in `tool_result.media`,
 * so request building shows it to a model with vision after the step's tool results, exactly as
 * an image the builtin `Read` read. The tool never names an attachment: the kernel stores the
 * bytes it was given and records the ids itself.
 */

/** The most image blocks of one tool result that are stored; the rest are named as not stored. */
export const RESULT_IMAGES_MAX = 10;

/**
 * Stores one image as a `read` copy of the calling conversation (`AttachmentsService.storeRead`
 * bound to it): the copy, or refused by the per-conversation cap. Throws `storage.unavailable`
 * without an object store.
 */
export type StoreResultImage = (file: {
  name: string;
  contentType: string;
  data: Uint8Array;
}) => Promise<{ ok: true; attachmentId: string; size: number } | { ok: false; reason: "cap" }>;

/** Why an image block was not stored (each one is said in the result text). */
export type NotStoredReason = "type" | "size" | "count" | "cap" | "storage" | "error";

/** The per-block texts (in image order) and the stored copies of one tool result. */
export interface ResultImages {
  /** One text per image block, in order: what the model reads in place of the block. */
  texts: string[];
  /** The stored copies, in order; absent when none was stored. */
  media?: ToolResultMedia[];
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * The name of a stored image: the tool's own name (the last `__` segment of its key), `-<n>` from
 * the second image of a result on, and the extension of its sniffed type.
 */
export function resultImageName(toolKey: string, index: number, mediaType: string): string {
  const at = toolKey.lastIndexOf("__");
  const base = (at === -1 ? toolKey : toolKey.slice(at + 2)) || "image";
  const ext = EXTENSIONS[mediaType] ?? "img";
  return `${base.slice(0, 200)}${index === 0 ? "" : `-${index + 1}`}.${ext}`;
}

const dimsText = (d: { width?: number; height?: number }): string =>
  d.width !== undefined && d.height !== undefined ? `, ${d.width}×${d.height}` : "";

/** A stored image in the result text (model-visible): its type, size, pixels and file_id. */
export const resultImageText = (
  mediaType: string,
  size: number,
  dims: { width?: number; height?: number },
  attachmentId: string,
): string => `[Image (${mediaType}, ${sizeText(size)}${dimsText(dims)}), file_id ${attachmentId}]`;

const REASON_TEXT: Record<NotStoredReason, string> = {
  type: "only PNG, JPEG, GIF and WebP images are stored.",
  size: "it is over the 5 MB image limit.",
  count: `a tool result stores at most ${RESULT_IMAGES_MAX} images.`,
  cap: "this conversation reached its limit for stored images.",
  storage: "file storage is not configured in this deployment.",
  error: "storing it failed.",
};

/**
 * An image block that was not stored (model-visible): it is neither shown to the model nor kept
 * in the history, and the text says so, so a model never takes the line for an image it saw.
 * Without a reason (a pipeline with no image store wired in) it says only that.
 */
export const resultImageNotStoredText = (
  mediaType: string,
  size: number,
  reason?: NotStoredReason,
): string =>
  `[Image (${clipType(mediaType)}, ${sizeText(size)}) not stored, so not shown${
    reason === undefined ? "." : `: ${REASON_TEXT[reason]}`
  }]`;

/** A declared media type as the text shows it (the tool's string, bounded). */
const clipType = (t: string): string => (t.length > 100 ? `${t.slice(0, 100)}…` : t);

/** base64 data decoded (Node accepts and skips characters outside the alphabet). */
const decode = (data: string): Uint8Array => new Uint8Array(Buffer.from(data, "base64"));

const isApiStorageUnavailable = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "storage.unavailable";

/**
 * Stores the image blocks of a tool result (`{ content: [...] }`, image blocks
 * `{ type: "image", data, mimeType }`), in order and one at a time, and returns the text for each
 * block and the stored copies; `undefined` when the result has no image block. A block is stored
 * when its bytes sniff as PNG, JPEG, GIF or WebP, are at most `MEDIA_LIMITS.imageBytes`, and it is
 * among the first {@link RESULT_IMAGES_MAX}; `store` absent or throwing `storage.unavailable`
 * means no object store; any other error is passed to `onError` and the block is not stored (the
 * call's result is still written).
 */
export async function storeResultImages(
  result: unknown,
  toolKey: string,
  store: StoreResultImage | undefined,
  onError?: (err: unknown) => void,
): Promise<ResultImages | undefined> {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.filter(
    (b): b is { type: "image"; data: string; mimeType?: unknown } =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string",
  );
  if (blocks.length === 0) return undefined;
  const texts: string[] = [];
  const media: ToolResultMedia[] = [];
  let noStorage = store === undefined;
  for (const [i, b] of blocks.entries()) {
    const declared = typeof b.mimeType === "string" ? b.mimeType : "unknown";
    const data = decode(b.data);
    const size = data.byteLength;
    const notStored = (reason: NotStoredReason) =>
      texts.push(resultImageNotStoredText(declared, size, reason));
    if (i >= RESULT_IMAGES_MAX) {
      notStored("count");
      continue;
    }
    const sniffed = sniffImage(data);
    if (sniffed === null) {
      notStored("type");
      continue;
    }
    if (size > MEDIA_LIMITS.imageBytes) {
      notStored("size");
      continue;
    }
    if (noStorage || store === undefined) {
      notStored("storage");
      continue;
    }
    const name = resultImageName(toolKey, media.length, sniffed.mediaType);
    try {
      const stored = await store({ name, contentType: sniffed.mediaType, data });
      if (!stored.ok) {
        notStored("cap");
        continue;
      }
      media.push({
        attachmentId: stored.attachmentId,
        name,
        mediaType: sniffed.mediaType,
        size: stored.size,
      });
      texts.push(resultImageText(sniffed.mediaType, stored.size, sniffed, stored.attachmentId));
    } catch (e) {
      if (isApiStorageUnavailable(e)) {
        noStorage = true;
        notStored("storage");
      } else {
        onError?.(e);
        notStored("error");
      }
    }
  }
  return { texts, ...(media.length > 0 && { media }) };
}
