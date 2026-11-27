import {
  getLibraryFile,
  type LibraryFilter,
  libraryFileText,
  libraryUsage,
  listLibraryFiles,
} from "../library-files";
import { listLibraryFilePreviewers, renderLibraryFilePreview } from "../previewers";
import type { UiLocale } from "../ui";
import { defineQuery } from "./define";
import { keys } from "./keys";

// The person's file library (file library spec §6, §8): the Files page's list, details and usage,
// a library file's previews, and the composer's `@` search (its shares: `./shares`).
//
// **`libraryFileSearchQuery(orgId, q)` is the composer `@` search entry point**: the `@` menu's
// recent files group reads `GET /api/v1/orgs/:orgId/files?q=<text after @>&limit=8` through it.
//
// Freshness `live`, not `mine`: agents deliver and generate files into the library on their own,
// so a list cached on a visit is read again after 30 s. Writes: `./library-mutations`.

/** How many files the composer's `@` search shows. */
export const LIBRARY_SEARCH_LIMIT = 8;

/** One page of the caller's ready files for a filter set, newest first. */
export const libraryFilesQuery = (orgId: string, filter: LibraryFilter = {}) =>
  defineQuery({
    key: keys.org(orgId).files(filter),
    fn: () => listLibraryFiles(orgId, filter),
    freshness: "live",
  });

/**
 * The composer `@` search: the caller's files whose name contains `q` (case-insensitive), at most
 * {@link LIBRARY_SEARCH_LIMIT}, newest first.
 */
export const libraryFileSearchQuery = (orgId: string, q: string) =>
  libraryFilesQuery(orgId, { q, limit: LIBRARY_SEARCH_LIMIT });

/** One library file's details (its conversations and versions); 404 `file.not_found`. */
export const libraryFileQuery = (orgId: string, fileId: string) =>
  defineQuery({
    key: keys.org(orgId).file(fileId),
    fn: () => getLibraryFile(orgId, fileId),
    freshness: "live",
  });

/** The caller's usage: bytes of the distinct blobs their ready files use, and the file count. */
export const libraryUsageQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).fileUsage(),
    fn: () => libraryUsage(orgId),
    freshness: "live",
  });

/** A library file's extension previewers, in the org's order. */
export const libraryPreviewersQuery = (orgId: string, fileId: string) =>
  defineQuery({
    key: keys.org(orgId).libraryPreviewers(fileId),
    fn: () => listLibraryFilePreviewers(orgId, fileId).then((r) => r.previewers),
    freshness: "orgConfig",
  });

/** A library file's preview by an extension previewer (a rendered view). */
export const libraryPreviewQuery = (
  orgId: string,
  fileId: string,
  p: { plugin: string; id: string },
  locale: UiLocale,
) =>
  defineQuery({
    key: keys.org(orgId).libraryPreview(fileId, `${p.plugin}/${p.id}`, locale),
    fn: () => renderLibraryFilePreview(orgId, fileId, p, locale).then((r) => r.view),
    freshness: "live",
  });

/** A library file's text for the built-in previews (the first bytes; `truncated` past them). */
export const libraryFileTextQuery = (orgId: string, fileId: string) =>
  defineQuery({
    key: keys.org(orgId).libraryPreview(fileId, "builtin", ""),
    fn: ({ signal }) => libraryFileText(orgId, fileId, signal),
    freshness: "live",
  });
