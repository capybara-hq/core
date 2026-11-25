import { MEDIA_LIMITS } from "@capybara-hq/plugin-sdk";
import sharp from "sharp";
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
 * The most pixels an image from a tool result may have: an external server can send a small,
 * highly compressible file that decodes to gigabytes. The same bound as the kernel's thumbnails
 * (`THUMBNAIL_MAX_INPUT_PIXELS`).
 */
export const RESULT_IMAGE_MAX_PIXELS = 40_000_000;

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
export type NotStoredReason =
  | "type"
  | "size"
  | "pixels"
  | "unreadable"
  | "count"
  | "cap"
  | "storage"
  | "error";

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
  pixels: `its pixel size is missing or over the limit of ${RESULT_IMAGE_MAX_PIXELS / 1_000_000} megapixels.`,
  unreadable: "it could not be decoded as a whole image.",
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

/** The decoded size of base64 data, without decoding it. */
export function base64Bytes(data: string): number {
  const s = data.replace(/\s/g, "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/**
 * An image block of a tool result: `{ type: "image", data: <base64 string>, mimeType? }`. The one
 * test {@link storeResultImages} and `renderResult` both use, so the n-th text always belongs to
 * the n-th image block.
 */
export function isToolImageBlock(
  b: unknown,
): b is { type: "image"; data: string; mimeType?: unknown } {
  return (
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(b) &&
    (b as { type?: unknown }).type === "image" &&
    typeof (b as { data?: unknown }).data === "string"
  );
}

/**
 * Whether the bytes decode as a whole image within {@link RESULT_IMAGE_MAX_PIXELS}: `pixels` when
 * the header's size is missing or over the bound, `unreadable` when decoding fails (a truncated
 * or corrupt body after valid magic bytes), else null. Decodes once, shrunk, so the cost is bounded
 * by the pixel limit.
 */
export async function checkResultImage(data: Uint8Array): Promise<"pixels" | "unreadable" | null> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = await sharp(data, { limitInputPixels: false }).metadata());
  } catch {
    return "unreadable";
  }
  if (!width || !height || width * height > RESULT_IMAGE_MAX_PIXELS) return "pixels";
  try {
    await sharp(data, { failOn: "truncated", limitInputPixels: RESULT_IMAGE_MAX_PIXELS })
      .resize(64, 64, { fit: "inside" })
      .toBuffer();
  } catch {
    return "unreadable";
  }
  return null;
}

const isApiStorageUnavailable = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "storage.unavailable";

/**
 * Stores the image blocks of a tool result (`{ content: [...] }`, blocks matching
 * {@link isToolImageBlock}), in order and one at a time, and returns the text for each block and
 * the stored copies; `undefined` when the result has no image block. A block is stored when it is
 * among the first {@link RESULT_IMAGES_MAX} and at most `MEDIA_LIMITS.imageBytes` (both checked
 * before decoding), its bytes sniff as PNG, JPEG, GIF or WebP, and it decodes as a whole image
 * within {@link RESULT_IMAGE_MAX_PIXELS}; `store` absent or throwing `storage.unavailable` means no
 * object store; any other error is passed to `onError` and the block is not stored (the call's
 * result is still written). `signal` (the run's) is checked before each image: a stopped run stores
 * nothing more. A copy stored before a crash that keeps the result from being written stays bound
 * and unreferenced until the conversation's purge (the same window as `Read`'s copies).
 */
export async function storeResultImages(
  result: unknown,
  toolKey: string,
  store: StoreResultImage | undefined,
  onError?: (err: unknown) => void,
  signal?: AbortSignal,
): Promise<ResultImages | undefined> {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  const blocks = content.filter(isToolImageBlock);
  if (blocks.length === 0) return undefined;
  const texts: string[] = [];
  const media: ToolResultMedia[] = [];
  let noStorage = store === undefined;
  for (const [i, b] of blocks.entries()) {
    const declared = typeof b.mimeType === "string" ? b.mimeType : "unknown";
    const declaredSize = base64Bytes(b.data);
    const notStored = (reason: NotStoredReason, size = declaredSize) =>
      texts.push(resultImageNotStoredText(declared, size, reason));
    if (i >= RESULT_IMAGES_MAX) {
      notStored("count");
      continue;
    }
    if (declaredSize > MEDIA_LIMITS.imageBytes) {
      notStored("size");
      continue;
    }
    if (noStorage || store === undefined) {
      notStored("storage");
      continue;
    }
    signal?.throwIfAborted();
    const data = decode(b.data);
    const size = data.byteLength;
    const sniffed = sniffImage(data);
    if (sniffed === null) {
      notStored("type", size);
      continue;
    }
    const bad = await checkResultImage(data);
    if (bad !== null) {
      notStored(bad, size);
      continue;
    }
    signal?.throwIfAborted();
    const name = resultImageName(toolKey, media.length, sniffed.mediaType);
    try {
      const stored = await store({ name, contentType: sniffed.mediaType, data });
      if (!stored.ok) {
        notStored("cap", size);
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
        notStored("storage", size);
      } else {
        onError?.(e);
        notStored("error", size);
      }
    }
  }
  return { texts, ...(media.length > 0 && { media }) };
}
