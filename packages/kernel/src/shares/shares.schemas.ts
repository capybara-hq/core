import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `POST …/conversations/:id/files/:fileId/shares` and its per-file list. */
export const ShareFileParams = z.object({
  id: z.string().min(1).max(100),
  fileId: z.string().min(1).max(100),
});

/**
 * A new share: who may open it and when it expires (days; null = never, internal only). An
 * external share needs a non-null expiry within the platform maximum (`share.expiry_too_long`).
 */
export const CreateShareBody = z
  .object({
    audience: z.enum(["internal", "external"]),
    expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).nullable(),
  })
  .strict();

/** `…/shares/:shareId` routes. */
export const ShareIdParams = z.object({ shareId: z.uuid() });

/** `GET …/shares`: the actor's own shares (`mine`, default) or every share of the org (`all`, org admins). */
export const ListSharesQuery = z.object({ scope: z.enum(["mine", "all"]).default("mine") });

/** The share routes a Platform operation mirrors (spec §10). */
export const SHARE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/shares", query: ListSharesQuery },
  { route: "DELETE /api/v1/orgs/:orgId/shares/:shareId", params: ShareIdParams },
];
