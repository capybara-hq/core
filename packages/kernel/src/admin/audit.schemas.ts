import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** The largest `bigserial` id; a larger `after` would make PG refuse the comparison. */
const MAX_BIGINT = 9223372036854775807n;

/** `GET /api/v1/admin/audit`: keyset paging by event id, newest first (admin overview spec §5.2). */
export const AuditListQuery = z.object({
  after: z
    .string()
    .regex(/^\d{1,19}$/, "after must be an event id (digits)")
    // checks do not abort: only digits reach BigInt
    .refine((v) => !/^\d{1,19}$/.test(v) || BigInt(v) <= MAX_BIGINT, "after must be an event id")
    .optional()
    .describe("The id of the last event of the previous page (its next); absent: the newest."),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const AUDIT_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/audit", query: AuditListQuery },
];
