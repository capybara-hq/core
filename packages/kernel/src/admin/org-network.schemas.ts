import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/**
 * `POST /api/v1/admin/orgs/:orgId/network-allowances`: one internal endpoint the org's extension
 * requests may reach (plugin safe fetch spec). The service checks and normalizes the entry and
 * refuses an invalid one with `org.network_allowance_invalid`.
 */
export const NetworkAllowanceBody = z.object({
  entry: z
    .string()
    .min(1)
    .max(300)
    .describe(
      "A hostname or *.domain wildcard (https, any port), an IP address or CIDR (e.g. 10.1.0.0/16), or an origin such as http://mcp.internal:8080 (exactly that origin, plain http allowed).",
    ),
});

/** `DELETE /api/v1/admin/orgs/:orgId/network-allowances/:id`. */
export const NetworkAllowanceParams = z.object({
  id: z.string().min(1).max(100).describe("The allowance id (from the list)."),
});

/** The super admin's org network allowance routes (the org admins' read is in `ORG_ROUTES`). */
export const ORG_NETWORK_ROUTES: readonly RouteSchemas[] = [
  // `:orgId` is never compared: the admin operations name the org with an `orgId` extra
  { route: "GET /api/v1/admin/orgs/:orgId/network-allowances" },
  { route: "POST /api/v1/admin/orgs/:orgId/network-allowances", body: NetworkAllowanceBody },
  {
    route: "DELETE /api/v1/admin/orgs/:orgId/network-allowances/:id",
    params: NetworkAllowanceParams,
  },
];
