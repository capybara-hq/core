/**
 * The device paths a `GenerateImage` call writes (image generation spec §5.3), shared by the tool
 * and the command review so the review judges exactly the files the tool writes.
 */

/** `path` with `-<i>` before the extension of its last segment (or at its end without one). */
export function suffixedPath(path: string, i: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  // a dot that starts the file name (`.env`) is not an extension
  if (dot <= slash + 1) return `${path}-${i}`;
  return `${path.slice(0, dot)}-${i}${path.slice(dot)}`;
}

/**
 * The paths a `GenerateImage` input writes into the device, in image order: none without
 * `file_path`, `file_path` itself for one image, `-1`, `-2`… before the extension for several
 * ({@link suffixedPath}). `n` absent or not a whole number above 1 is one image.
 */
export function generateImagePaths(input: unknown): string[] {
  const o = (input ?? {}) as { file_path?: unknown; n?: unknown };
  if (typeof o.file_path !== "string") return [];
  const n = typeof o.n === "number" && Number.isInteger(o.n) && o.n > 1 ? o.n : 1;
  const path = o.file_path;
  return n === 1 ? [path] : Array.from({ length: n }, (_, i) => suffixedPath(path, i + 1));
}
