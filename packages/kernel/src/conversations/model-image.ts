import sharp from "sharp";
import type { MediaBytes } from "../runtime/context/build.js";

/**
 * The longest edge, in pixels, of an image sent to a model. Providers scale larger images down on
 * their side anyway (to roughly 1.5k-2k pixels), so the extra pixels only cost upload time on every
 * request that carries the image again.
 */
export const MODEL_IMAGE_MAX_EDGE = 2048;

/** An image at most this large and within {@link MODEL_IMAGE_MAX_EDGE} is sent unchanged. */
export const MODEL_IMAGE_KEEP_BYTES = 1_048_576;

/** Quality of the re-encoded copy (JPEG, or WebP for an image with transparent pixels). */
const QUALITY = 85;

/** Types {@link fitImageForModel} re-encodes; others (GIF, which may be animated) pass through. */
const RESIZABLE = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * The copy of an image a model request carries. Images over {@link MODEL_IMAGE_KEEP_BYTES} or
 * larger than {@link MODEL_IMAGE_MAX_EDGE} on an edge are scaled to fit that edge (never enlarged)
 * and re-encoded: JPEG when every pixel is opaque, WebP when some are transparent, so transparency
 * stays visible. The result is a pure function of the stored bytes, so rebuilding a recorded request
 * gives the same copy. The stored attachment is never changed. Bytes that fail to decode, and a
 * re-encoded copy no smaller than the original, are returned unchanged.
 */
export async function fitImageForModel(media: MediaBytes): Promise<MediaBytes> {
  if (!RESIZABLE.has(media.mediaType)) return media;
  try {
    const image = sharp(media.data, { failOn: "error" });
    const meta = await image.metadata();
    if (
      media.data.byteLength <= MODEL_IMAGE_KEEP_BYTES &&
      Math.max(meta.width, meta.height) <= MODEL_IMAGE_MAX_EDGE
    ) {
      return media;
    }
    const opaque = !meta.hasAlpha || (await image.stats()).isOpaque;
    const resized = image.autoOrient().resize({
      width: MODEL_IMAGE_MAX_EDGE,
      height: MODEL_IMAGE_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });
    const data = opaque
      ? await resized.flatten({ background: "#ffffff" }).jpeg({ quality: QUALITY }).toBuffer()
      : await resized.webp({ quality: QUALITY }).toBuffer();
    if (data.byteLength >= media.data.byteLength) return media;
    return { mediaType: opaque ? "image/jpeg" : "image/webp", data: new Uint8Array(data) };
  } catch {
    return media;
  }
}

/** How long a model-sized copy stays cached (the steps of a conversation reuse it). */
export const MODEL_IMAGE_CACHE_SECONDS = 3600;

/**
 * The cache key of an attachment's model-sized copy: its id plus its recorded etag (or size), with
 * the scaling version, so a changed rule or object never serves an old copy.
 */
export const modelImageKey = (
  orgId: string,
  row: { id: string; etag: string | null; size: number | string },
): string => `model_image:v1:${orgId}:${row.id}:${row.etag ?? `size-${row.size}`}`;

/** The cached form of a copy: its media type, a newline, then the bytes in base64. */
export function serializeModelImage(media: MediaBytes): string {
  return `${media.mediaType}\n${Buffer.from(media.data).toString("base64")}`;
}

/** A cached copy read back, or null on a miss or a value that is not one. */
export function parseModelImage(raw: string | undefined): MediaBytes | null {
  if (raw === undefined) return null;
  const nl = raw.indexOf("\n");
  const mediaType = raw.slice(0, nl);
  if (nl < 0 || !RESIZABLE.has(mediaType)) return null;
  const data = Buffer.from(raw.slice(nl + 1), "base64");
  return data.byteLength === 0 ? null : { mediaType, data: new Uint8Array(data) };
}
