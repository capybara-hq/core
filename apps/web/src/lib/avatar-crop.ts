/**
 * Avatar crop (agent profile design §2.3): the picked image is center-cropped to a square on a
 * canvas and re-encoded, at most {@link AVATAR_CROP_MAX} px a side, so the upload stays well under
 * the kernel's 2 MB limit. PNG first; WebP when the PNG would be over the limit.
 */

export const AVATAR_CROP_MAX = 512;
/** The kernel's limit (`AGENT_AVATAR_MAX_BYTES`). */
export const AVATAR_MAX_BYTES = 2_097_152;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("avatar image could not be read"));
    };
    img.src = url;
  });
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

/** The square, re-encoded image; rejects when the browser cannot read or draw it. */
export async function cropAvatar(file: Blob): Promise<Blob> {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (side === 0) throw new Error("avatar image is empty");
  const out = Math.min(side, AVATAR_CROP_MAX);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const g = canvas.getContext("2d");
  if (g === null) throw new Error("avatar canvas is unavailable");
  g.imageSmoothingQuality = "high";
  g.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    out,
    out,
  );
  const png = await encode(canvas, "image/png");
  if (png !== null && png.size <= AVATAR_MAX_BYTES) return png;
  const webp = await encode(canvas, "image/webp", 0.9);
  // a browser without WebP encoding answers PNG again: the kernel then refuses an oversize file
  const best = webp ?? png;
  if (best === null) throw new Error("avatar image could not be encoded");
  return best;
}
