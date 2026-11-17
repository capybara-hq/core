import { DOCUMENT_MEDIA_TYPES, IMAGE_MEDIA_TYPES } from "@capybara-hq/plugin-sdk";

/**
 * Whether a chat attachment with this content type becomes an `image` block: one of the four image
 * types a model can view.
 */
export function isImageContentType(ct: string): boolean {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(ct);
}

/**
 * Whether the model can consume the content itself, so the attachment becomes an `image` or
 * `document` block: the image types, a PDF, and the text types (inlined, or sent as a document).
 * Every other accepted type is a `file` attachment the model only ever gets a reference to.
 */
export function isMediaContentType(ct: string): boolean {
  return isImageContentType(ct) || (DOCUMENT_MEDIA_TYPES as readonly string[]).includes(ct);
}

/**
 * The extension of a file name, lower case and without the dot: `null` when it has none or when the
 * suffix is not an extension-shaped word (`a.`, `a.verylongsuffix`).
 */
export function attachmentExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : null;
}

/**
 * Whether a chat upload is accepted: its declared content type, or else the extension of its file
 * name (`attachments.allowedExtensions`, for source files and office documents whose content types
 * disagree across browsers and systems). The web applies the same rule before uploading.
 */
export function acceptedContent(
  cfg: { allowedTypes: readonly string[]; allowedExtensions: readonly string[] },
  name: string,
  contentType: string,
): boolean {
  if ((cfg.allowedTypes as readonly string[]).includes(contentType)) return true;
  const ext = attachmentExtension(name);
  return ext !== null && (cfg.allowedExtensions as readonly string[]).includes(ext);
}
