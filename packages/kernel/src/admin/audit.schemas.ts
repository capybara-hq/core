import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** The largest `bigserial` id; a larger `after` would make PG refuse the comparison. */
const MAX_BIGINT = 9223372036854775807n;

/**
 * A page of an audit log: keyset paging by event id, newest first (admin overview spec §5.2), and
 * an optional action prefix.
 */
const AuditPageQuery = z.object({
  after: z
    .string()
    .regex(/^\d{1,19}$/, "after must be an event id (digits)")
    // checks do not abort: only digits reach BigInt
    .refine((v) => !/^\d{1,19}$/.test(v) || BigInt(v) <= MAX_BIGINT, "after must be an event id")
    .optional()
    .describe("The id of the last event of the previous page (its next); absent: the newest."),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  action: z
    .string()
    .regex(/^[a-z][a-z0-9_.]{0,63}$/, "action must be an action name or its prefix (a-z 0-9 _ .)")
    .optional()
    .describe("Only actions starting with this, e.g. connector. or org.member.added."),
});

/** `GET /api/v1/admin/audit`: the platform's events, or with `orgId` that org's. */
export const AuditListQuery = AuditPageQuery.extend({
  orgId: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Read this org's events instead of the platform's."),
});

/** `GET /api/v1/orgs/:orgId/audit`: the org's own events (org admins). */
export const OrgAuditListQuery = AuditPageQuery;

export const AUDIT_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/audit", query: AuditListQuery },
  { route: "GET /api/v1/orgs/:orgId/audit", query: OrgAuditListQuery },
];
