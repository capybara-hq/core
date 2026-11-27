import { hasControlChars, MEDIA_NAME_MAX_CHARS } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** A hex sha256 (lower case), as the web computes it before uploading. */
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lower-case hex digits");

/** Where the upload is made: `composer` (a draft until sent) or `library` (ready at once). */
const Purpose = z.enum(["composer", "library"]);

/** `POST /files`: the file to upload and the sha256 the web computed over its bytes. */
export const FileCreateBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MEDIA_NAME_MAX_CHARS)
      .refine((s) => !hasControlChars(s), "name must not contain control characters"),
    contentType: z.string().min(1).max(200),
    size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256,
    purpose: Purpose,
  })
  .strict();

/** The origins of a library file, as `GET /files?origin=` filters them. */
export const LIBRARY_ORIGINS = ["upload", "delivered", "generated"] as const;
/** The kinds `GET /files?type=` filters by (the content type's family). */
export const LIBRARY_TYPES = ["image", "document", "text", "other"] as const;
/** The most files one page of `GET /files` returns. */
export const LIBRARY_PAGE_MAX = 100;

/**
 * `GET /files`: the caller's ready files, newest first. `q`: a case-insensitive substring of the
 * name (the composer's `@` search); `cursor`: the `next` of the previous page.
 */
export const LibraryListQuery = z.object({
  origin: z.enum(LIBRARY_ORIGINS).optional(),
  agentId: z.string().min(1).max(100).optional(),
  type: z.enum(LIBRARY_TYPES).optional(),
  q: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(LIBRARY_PAGE_MAX).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

/** `…/files/:id` routes. */
export const FileIdParams = z.object({ id: z.string().min(1).max(100) });

/** The library routes a Platform operation mirrors (file library spec §6). */
export const FILE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/files", query: LibraryListQuery },
  { route: "GET /api/v1/orgs/:orgId/files/usage" },
  { route: "GET /api/v1/orgs/:orgId/files/:id", params: FileIdParams },
  { route: "DELETE /api/v1/orgs/:orgId/files/:id", params: FileIdParams },
];
