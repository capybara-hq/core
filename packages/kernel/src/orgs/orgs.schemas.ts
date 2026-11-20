import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { INVITABLE_ROLES, MAX_INVITATION_HOURS } from "./invitations.service.js";
import { ORG_ROLES } from "./roles.js";
import { OrgSettingsPatchSchema } from "./settings.service.js";

export const OrgUpdateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z.string().min(1).max(40).optional(),
});

/** `POST /api/v1/orgs/:orgId/invitations`: the role invited (never owner) and the link's life. */
export const InvitationCreateBody = z.object({
  role: z.enum(INVITABLE_ROLES),
  expiresInHours: z.number().int().min(1).max(MAX_INVITATION_HOURS).optional(),
});

/** `DELETE /api/v1/orgs/:orgId/invitations/:id`. */
export const InvitationIdParams = z.object({ id: z.string().min(1).max(100) });

/** `PATCH` / `DELETE /api/v1/orgs/:orgId/members/:accountId`. */
export const MemberParams = z.object({ accountId: z.string().min(1).max(100) });

/** `PATCH /api/v1/orgs/:orgId/members/:accountId`. */
export const MemberRoleBody = z.object({ role: z.enum(ORG_ROLES) });

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
  {
    route: "PATCH /api/v1/orgs/:orgId/members/:accountId",
    params: MemberParams,
    body: MemberRoleBody,
  },
  { route: "DELETE /api/v1/orgs/:orgId/members/:accountId", params: MemberParams },
  { route: "POST /api/v1/orgs/:orgId/invitations", body: InvitationCreateBody },
  { route: "GET /api/v1/orgs/:orgId/invitations" },
  { route: "DELETE /api/v1/orgs/:orgId/invitations/:id", params: InvitationIdParams },
  { route: "GET /api/v1/orgs/:orgId/network-allowances" },
];

export const ORG_SETTINGS_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/settings" },
  { route: "PATCH /api/v1/orgs/:orgId/settings", body: OrgSettingsPatchSchema },
];
