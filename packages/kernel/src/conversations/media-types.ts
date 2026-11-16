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
