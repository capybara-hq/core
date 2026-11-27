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

/**
 * `POST /files/:id/finalize`: the sha256 the web computed (checked against the bytes read) and the
 * upload's purpose (the composer's draft by default).
 */
export const FileFinalizeBody = z
  .object({ sha256: Sha256, purpose: Purpose.default("composer") })
  .strict();

/** The file upload routes (the composer's and the Files page's), for the Platform tool's list. */
export const LIBRARY_FILE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/files/limits" },
  { route: "POST /api/v1/orgs/:orgId/files", body: FileCreateBody },
  { route: "POST /api/v1/orgs/:orgId/files/:id/finalize", body: FileFinalizeBody },
  { route: "DELETE /api/v1/orgs/:orgId/files/:id/draft" },
];
