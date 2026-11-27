import { apiFetch } from "./api";
import { readTextPreview, TEXT_PREVIEW_BYTES } from "./files";
import { type UploadedFile, uploadFile } from "./uploads";

/**
 * The person's file library (kernel `files/library.controller.ts`, file library spec §6, §8): every
 * file the person uploaded or an agent delivered or generated for them, newest first, with the
 * deliveries of one source path in one conversation collapsed to the newest (`versions`). Only the
 * caller's own files: another account's file is 404 `file.not_found` on every route.
 */

/** Where a library file came from. */
export type LibraryOrigin = "upload" | "delivered" | "generated";
/** The content type families `GET /files?type=` filters by. */
export type LibraryType = "image" | "document" | "text" | "other";

/** A conversation a library file belongs to or is referred to by. */
export interface LibraryConversation {
  id: string;
  title: string | null;
  deleted: boolean;
}

/** One entry of the library list: a file, or the newest version of a delivery. */
export interface LibraryFileView {
  id: string;
  name: string;
  contentType: string;
  size: number;
  origin: LibraryOrigin;
  /** The agent that delivered or generated it; null for an upload. */
  agentId: string | null;
  /** That agent's current name, when it can be read. */
  agentName?: string;
  /** Where it was delivered, or first sent; null when not known (or not the caller's). */
  sourceConversation: LibraryConversation | null;
  /** The ready versions of its delivery group (1 for an upload). */
  versions: number;
  createdAt: string;
  /** The built-in preview kind (`image`, `text`), null otherwise. */
  previewable: "image" | "text" | null;
}

/** `GET /files/:id`: the view, the owner's conversations referring to it and its versions. */
export interface LibraryFileDetails {
  file: LibraryFileView;
  conversations: LibraryConversation[];
  /** Newest first. */
  versions: { id: string; size: number; createdAt: string }[];
}

/** `GET /files/usage`: the caller's ready files and the bytes of the distinct blobs they use. */
export interface LibraryUsage {
  bytes: number;
  files: number;
}

/** The list's filters and page (each set is its own cache entry). */
export interface LibraryFilter {
  origin?: LibraryOrigin;
  agentId?: string;
  type?: LibraryType;
  /** A case-insensitive substring of the name (the composer's `@` search). */
  q?: string;
  /** At most 100; the kernel's default is 50. */
  limit?: number;
  /** The `next` of the previous page. */
  cursor?: string;
}

/** One page of the list. */
export interface LibraryPage {
  files: LibraryFileView[];
  next: string | null;
}

const enc = encodeURIComponent;
const base = (orgId: string) => `/api/v1/orgs/${enc(orgId)}/files`;
const one = (orgId: string, id: string) => `${base(orgId)}/${enc(id)}`;

/** The query string of a filter: only the fields set, in a fixed order. */
export function libraryFilterQuery(f: LibraryFilter): string {
  const p = new URLSearchParams();
  if (f.origin !== undefined) p.set("origin", f.origin);
  if (f.agentId !== undefined && f.agentId !== "") p.set("agentId", f.agentId);
  if (f.type !== undefined) p.set("type", f.type);
  if (f.q !== undefined && f.q.trim() !== "") p.set("q", f.q.trim());
  if (f.limit !== undefined) p.set("limit", String(f.limit));
  if (f.cursor !== undefined) p.set("cursor", f.cursor);
  const s = p.toString();
  return s === "" ? "" : `?${s}`;
}

/** One page of the caller's ready files, newest first. */
export const listLibraryFiles = (orgId: string, filter: LibraryFilter = {}) =>
  apiFetch<LibraryPage>(`${base(orgId)}${libraryFilterQuery(filter)}`);

/** One file's details; 404 `file.not_found` when it is not the caller's or is deleted. */
export const getLibraryFile = (orgId: string, id: string) =>
  apiFetch<LibraryFileDetails>(one(orgId, id));

/** The caller's usage (bytes of the distinct blobs their ready files use). */
export const libraryUsage = (orgId: string) => apiFetch<LibraryUsage>(`${base(orgId)}/usage`);

/** Deletes the file and revokes its shares (204). */
export const deleteLibraryFile = (orgId: string, id: string) =>
  apiFetch<void>(one(orgId, id), { method: "DELETE" });

/**
 * Uploads a file into the library: hash, `POST /files` with `purpose: "library"`, the bytes to the
 * store (skipped when the caller already holds them), finalize. The file is ready at once.
 */
export const uploadLibraryFile = (
  orgId: string,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<UploadedFile> => uploadFile(orgId, file, { ...opts, purpose: "library" });

/** The first bytes of a text file for the built-in previews; `truncated` when cut. */
export const libraryFileText = (orgId: string, id: string, signal?: AbortSignal) =>
  readTextPreview(`${one(orgId, id)}/content?limit=${TEXT_PREVIEW_BYTES}`, signal);

/** The download address (same origin; the kernel redirects to a presigned address). */
export const libraryDownloadUrl = (orgId: string, id: string, opts: { inline?: boolean } = {}) =>
  `${one(orgId, id)}/download${opts.inline ? "?inline=1" : ""}`;
