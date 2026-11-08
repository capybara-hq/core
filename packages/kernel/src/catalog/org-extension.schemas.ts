import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** Route parameters of the overrides and tool switch routes (decision R20). */
export const OrgExtensionParams = z.object({ extension: z.string().min(1).max(64) });
export const OrgExtensionToolParams = OrgExtensionParams.extend({
  tool: z.string().min(1).max(64),
});

export const OrgToolSwitchPut = z
  .object({
    enabled: z.boolean(),
    /** The hash of the switch-off preview, to confirm turning the tool off. */
    confirm: z.string().min(1).max(128).optional(),
  })
  .strict();

export const ORG_EXTENSION_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/extensions" },
  { route: "GET /api/v1/orgs/:orgId/extensions/:extension/tools", params: OrgExtensionParams },
  {
    route: "PUT /api/v1/orgs/:orgId/extensions/:extension/tools/:tool",
    params: OrgExtensionToolParams,
    body: OrgToolSwitchPut,
  },
];
