/**
 * Object storage contract `object-store@1`: a single-select, brokered extension point (extensions
 * may not `requires` it; they use it through `ctx.storage`). The provider implements
 * {@link ObjectStore}; the `ctx.storage` an extension gets ({@link ExtensionStorage}) is wrapped by
 * the kernel: every method takes a leading `orgId`, and keys get the prefix
 * `plugins/<extension name>/<orgId>/`.
 */

/** Object storage extension point ref. */
export const OBJECT_STORE_EXTENSION_POINT = "object-store@1";

/** Metadata of an object. */
export interface ObjectHead {
  key: string;
  /** Size in bytes. */
  size: number;
  contentType: string;
  etag?: string;
  /** ISO 8601 time. */
  lastModified?: string;
}

/**
 * The `object-store@1` implementation (provided by an object-store plugin, e.g. S3-compatible
 * storage).
 */
export interface ObjectStore {
  /**
   * Writes (overwriting a key of the same name); give `size` when `body` is a stream if possible.
   */
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts: { contentType: string; size?: number; signal?: AbortSignal },
  ): Promise<ObjectHead>;
  /**
   * Reads; returns null when missing. `range` is a closed byte range; an omitted `end` means read
   * to the end.
   * With `range`, `head.size` is still the size of the whole object; when the store ignores Range,
   * body may be the whole object.
   */
  get(
    key: string,
    opts?: { signal?: AbortSignal; range?: { start: number; end?: number } },
  ): Promise<{ head: ObjectHead; body: ReadableStream<Uint8Array> } | null>;
  /** Returns null when missing. */
  head(key: string): Promise<ObjectHead | null>;
  /** Deletes; a missing key also counts as success. */
  delete(key: string): Promise<void>;
  /**
   * Deletes all objects under a prefix and returns the number deleted (used for org data deletion).
   */
  deletePrefix(prefix: string): Promise<number>;
  /**
   * Lists objects under a prefix with pagination; an omitted `cursor` in the result means there is
   * no next page. When the listing carries no type, `contentType` is an empty string
   * (use `head` to get it when needed).
   */
  list(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ObjectHead[]; cursor?: string }>;
  /** Presigned download URL (options in {@link PresignGetOptions}). */
  presignGet(key: string, opts: PresignGetOptions): Promise<string>;
  /**
   * Presigned upload: the browser uploads straight to storage following the returned {@link
   * PresignedUpload}. An upload over `maxSize` must be rejected by the **store side**
   * (a presigned PUT cannot limit the size, so S3-compatible implementations use a POST policy with
   * a `content-length-range` condition).
   */
  presignPut(
    key: string,
    opts: { contentType: string; maxSize: number; ttlSeconds: number },
  ): Promise<PresignedUpload>;
}

/** Options of a presigned download. */
export interface PresignGetOptions {
  ttlSeconds: number;
  /**
   * Download file name, goes into `Content-Disposition` (RFC 6266; non-ASCII uses
   * `filename*=UTF-8''…`).
   */
  downloadName?: string;
  /**
   * How the browser opens it: `attachment` (default, download) or `inline` (display in the page).
   * User-uploaded content should use `inline` only for types
   * that do not execute scripts (images, PDF).
   */
  disposition?: "attachment" | "inline";
  /**
   * Overrides the response `Content-Type` (e.g. return the verified type rather than the type
   * recorded in storage).
   */
  responseContentType?: string;
}

/**
 * The request method of a presigned upload:
 * - `PUT`: the request body is the file bytes, and the request carries `headers`;
 * - `POST`: a `multipart/form-data` form; first put every item of `fields` in as is, and put the
 *   file field `file` **last**;
 *   the request carries `headers` (usually empty).
 */
export interface PresignedUpload {
  method: "PUT" | "POST";
  url: string;
  headers: Record<string, string>;
  /** Always present for `POST`: the form fields (including policy and signature). */
  fields?: Record<string, string>;
}
