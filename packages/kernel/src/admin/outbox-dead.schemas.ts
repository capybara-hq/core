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

/** The most dead rows one page of `GET /api/v1/admin/outbox/dead` returns. */
export const OUTBOX_DEAD_LIST_MAX = 200;

/** A page cursor: the last row's `dead_at` (as PG prints it, microseconds) and id. */
export interface OutboxDeadCursor {
  deadAt: string;
  id: string;
}

const CURSOR_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

/** The opaque `next` / `after` token of a page ending at `c`. */
export const encodeOutboxDeadCursor = (c: OutboxDeadCursor): string =>
  Buffer.from(`${c.deadAt}|${c.id}`, "utf8").toString("base64url");

/** The cursor in `token`, or null when it is not one {@link encodeOutboxDeadCursor} made. */
export function decodeOutboxDeadCursor(token: string): OutboxDeadCursor | null {
  const [deadAt, id, ...rest] = Buffer.from(token, "base64url").toString("utf8").split("|");
  if (deadAt === undefined || id === undefined || rest.length > 0) return null;
  if (!CURSOR_TS.test(deadAt) || !/^\d{1,19}$/.test(id) || BigInt(id) > MAX_BIGINT) return null;
  return { deadAt, id };
}

/** `GET /api/v1/admin/outbox/dead`: keyset paging by `(dead_at, id)`, oldest first. */
export const OutboxDeadListQuery = z.object({
  after: z
    .string()
    .max(200)
    .refine(
      (v) => decodeOutboxDeadCursor(v) !== null,
      "after must be a cursor from a previous page",
    )
    .optional()
    .describe("The `next` of the previous page; absent: the oldest dead rows."),
  limit: z.coerce.number().int().min(1).max(OUTBOX_DEAD_LIST_MAX).default(OUTBOX_DEAD_LIST_MAX),
});

/** The super admin's dead outbox rows (transactional outbox spec §3.4). */
export const OUTBOX_DEAD_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/outbox/dead", query: OutboxDeadListQuery },
  { route: "POST /api/v1/admin/outbox/dead/:id/retry", params: OutboxDeadParams },
  { route: "DELETE /api/v1/admin/outbox/dead/:id", params: OutboxDeadParams },
];
