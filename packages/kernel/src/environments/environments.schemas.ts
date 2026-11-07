import type { RouteSchemas } from "../platform/route-schemas.js";
import { EnvironmentNameBody, EnvironmentParams } from "./dto.js";

/** The environments routes the Platform operations mirror (`check:platform-ops` keys). */
export const ENVIRONMENT_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/environments" },
  { route: "POST /api/v1/orgs/:orgId/environments", body: EnvironmentNameBody },
  { route: "GET /api/v1/orgs/:orgId/environments/:id", params: EnvironmentParams },
  {
    route: "PATCH /api/v1/orgs/:orgId/environments/:id",
    params: EnvironmentParams,
    body: EnvironmentNameBody,
  },
  { route: "DELETE /api/v1/orgs/:orgId/environments/:id", params: EnvironmentParams },
  { route: "POST /api/v1/orgs/:orgId/environments/:id/files/reset", params: EnvironmentParams },
];
