import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** The largest `bigint` id; a larger one would make PG refuse the comparison. */
const MAX_BIGINT = 9223372036854775807n;

/** A dead outbox row by id (`bigint` identity, read as a string; 400 when not digits). */
export const OutboxDeadParams = z.object({
  id: z
    .string()
    .regex(/^\d{1,19}$/, "id must be an outbox row id (digits)")
    // checks do not abort: only digits reach BigInt
    .refine((v) => !/^\d{1,19}$/.test(v) || BigInt(v) <= MAX_BIGINT, "id must be an outbox row id")
    .describe("The dead row's id, as admin.outbox-list-dead lists it."),
});

/** The super admin's dead outbox rows (transactional outbox spec §3.4). */
export const OUTBOX_DEAD_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/outbox/dead" },
  { route: "POST /api/v1/admin/outbox/dead/:id/retry", params: OutboxDeadParams },
  { route: "DELETE /api/v1/admin/outbox/dead/:id", params: OutboxDeadParams },
];
