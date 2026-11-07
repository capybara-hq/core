import type { RouteSchemas } from "../platform/route-schemas.js";

export const ORG_EXTENSION_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/extensions" },
];
