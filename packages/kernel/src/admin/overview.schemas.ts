import type { RouteSchemas } from "../platform/route-schemas.js";

/** The admin overview's routes (admin overview spec §5.2): reads without input. */
export const OVERVIEW_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/overview" },
  { route: "GET /api/v1/admin/overview/attention" },
];
