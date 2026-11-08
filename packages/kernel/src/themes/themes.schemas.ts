import type { RouteSchemas } from "../platform/route-schemas.js";

/** The theme routes the Platform operations mirror (`check:platform-ops` keys). */
export const THEME_ROUTES: readonly RouteSchemas[] = [{ route: "GET /api/v1/orgs/:orgId/themes" }];
