import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { OrgSettingsPatchSchema } from "./settings.service.js";

export const OrgUpdateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(40).optional(),
});

/** One org network allowance as the routes and Platform operations return it. */
export interface NetworkAllowanceView {
  id: string;
  entry: string;
  createdAt: Date;
}

/** The view of a stored allowance: who added it stays in the audit log. */
export function networkAllowanceView(a: {
  id: string;
  entry: string;
  createdAt: Date;
}): NetworkAllowanceView {
  return { id: a.id, entry: a.entry, createdAt: a.createdAt };
}

export const ORG_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs" },
  { route: "GET /api/v1/orgs/:orgId" },
  { route: "PATCH /api/v1/orgs/:orgId", body: OrgUpdateBody },
  { route: "GET /api/v1/orgs/:orgId/members" },
  { route: "GET /api/v1/orgs/:orgId/network-allowances" },
];

export const ORG_SETTINGS_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/settings" },
  { route: "PATCH /api/v1/orgs/:orgId/settings", body: OrgSettingsPatchSchema },
];
