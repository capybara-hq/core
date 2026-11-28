import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `:id` of a notice dismissal (the org's and the platform's inbox). */
export const InboxNoticeParams = z.object({ id: z.string().min(1).max(100) });

/** `:id` of a personal inbox item. */
export const InboxItemParams = z.object({ id: z.string().min(1).max(100) });

/** `:id/actions/:actionId` of a personal inbox item's button. */
export const InboxItemActionParams = z.object({
  id: z.string().min(1).max(100),
  actionId: z.string().min(1).max(100),
});

/** The body of an action click: the locale the action's toast is for. */
export const InboxItemActionBody = z
  .object({ locale: z.enum(["zh", "en"]).default("en") })
  .strict();

/**
 * The inbox routes (the org's and the super admin's) the Platform inbox operations mirror; the
 * click on a personal item's action is excluded (`human-only`, `platform/exclusions.ts`).
 */
export const INBOX_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/inbox" },
  { route: "POST /api/v1/orgs/:orgId/inbox/notices/:id/dismiss", params: InboxNoticeParams },
  { route: "POST /api/v1/orgs/:orgId/inbox/items/:id/dismiss", params: InboxItemParams },
  { route: "GET /api/v1/admin/inbox" },
  { route: "GET /api/v1/admin/inbox/count" },
  { route: "POST /api/v1/admin/inbox/notices/:id/dismiss", params: InboxNoticeParams },
];
