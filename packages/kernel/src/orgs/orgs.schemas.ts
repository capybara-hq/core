import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { OrgSettingsPatchSchema } from "./settings.service.js";

export const OrgUpdateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(40).optional(),
});

export const ORG_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs" },
  { route: "GET /api/v1/orgs/:orgId" },
  { route: "PATCH /api/v1/orgs/:orgId", body: OrgUpdateBody },
  { route: "GET /api/v1/orgs/:orgId/members" },
];

export const ORG_SETTINGS_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/settings" },
  { route: "PATCH /api/v1/orgs/:orgId/settings", body: OrgSettingsPatchSchema },
];
