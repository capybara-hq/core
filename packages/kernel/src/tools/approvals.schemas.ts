import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `GET /approvals?status=`: absent lists every status. */
export const ApprovalsListQuerySchema = z
  .object({ status: z.enum(["pending", "approved", "denied", "expired", "cancelled"]).optional() })
  .strict();

/** `:id` of `GET /approvals/:id`, as the route takes it (`@Param`). */
export const ApprovalPathParams = z.object({ id: z.string() });

/**
 * The approval reads a Platform operation mirrors. Deciding (`POST /approvals/:id/decision`) is a
 * person's act and stays excluded (spec §6.4, §14.1 item 2), so it has no entry here.
 */
export const APPROVAL_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/approvals", query: ApprovalsListQuerySchema },
  { route: "GET /api/v1/orgs/:orgId/approvals/:id", params: ApprovalPathParams },
];
