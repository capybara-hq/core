import type { RouteSchemas } from "../platform/route-schemas.js";
import { DeviceNameBody, DeviceParams } from "./dto.js";

/** The devices routes the Platform operations mirror (`check:platform-ops` keys). */
export const DEVICE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/devices" },
  { route: "POST /api/v1/orgs/:orgId/devices", body: DeviceNameBody },
  { route: "GET /api/v1/orgs/:orgId/devices/:id", params: DeviceParams },
  {
    route: "PATCH /api/v1/orgs/:orgId/devices/:id",
    params: DeviceParams,
    body: DeviceNameBody,
  },
  { route: "DELETE /api/v1/orgs/:orgId/devices/:id", params: DeviceParams },
  { route: "POST /api/v1/orgs/:orgId/devices/:id/files/reset", params: DeviceParams },
];
