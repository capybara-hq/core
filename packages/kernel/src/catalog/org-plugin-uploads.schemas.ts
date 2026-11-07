import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

export const OrgUploadStagingParams = z.object({ stagingId: z.string().min(1).max(100) });
export const OrgOwnedPluginParams = z.object({ id: z.string().min(1).max(100) });

export const OrgUploadConfirmBody = z
  .object({
    reviewHash: z.string().min(1).max(128),
    /** The org shares the new item with other orgs (default false, P3-16). */
    shareable: z.boolean().optional(),
    /** Skill names suggested as pinned (spec §9.1); omitted keeps the plugin's flags. */
    pinnedSuggestions: z.array(z.string().min(1).max(64)).max(50).optional(),
  })
  .strict();

export const OrgOwnedShareableBody = z.object({ shareable: z.boolean() }).strict();
export const OrgOwnedDeleteBody = z.object({ previewHash: z.string().min(1).max(128) }).strict();

export const ORG_PLUGIN_UPLOAD_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/catalog/uploads/:stagingId", params: OrgUploadStagingParams },
  {
    route: "PUT /api/v1/orgs/:orgId/owned-plugins/:id/shareable",
    params: OrgOwnedPluginParams,
    body: OrgOwnedShareableBody,
  },
  {
    route: "POST /api/v1/orgs/:orgId/owned-plugins/:id/delete/preview",
    params: OrgOwnedPluginParams,
  },
  {
    route: "POST /api/v1/orgs/:orgId/owned-plugins/:id/delete",
    params: OrgOwnedPluginParams,
    body: OrgOwnedDeleteBody,
  },
  { route: "DELETE /api/v1/orgs/:orgId/owned-plugins/:id/pending", params: OrgOwnedPluginParams },
];
