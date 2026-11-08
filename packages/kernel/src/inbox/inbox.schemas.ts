import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `:id` of a notice dismissal (the org's and the platform's inbox). */
export const InboxNoticeParams = z.object({ id: z.string().min(1).max(100) });

/** The inbox routes (the org's and the super admin's) the Platform inbox operations mirror. */
export const INBOX_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/inbox" },
  { route: "POST /api/v1/orgs/:orgId/inbox/notices/:id/dismiss", params: InboxNoticeParams },
  { route: "GET /api/v1/admin/inbox" },
  { route: "GET /api/v1/admin/inbox/count" },
  { route: "POST /api/v1/admin/inbox/notices/:id/dismiss", params: InboxNoticeParams },
];
