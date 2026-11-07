import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

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
