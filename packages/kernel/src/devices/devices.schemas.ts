import type { RouteSchemas } from "../platform/route-schemas.js";
import { DeviceNameBody, DeviceParams, DevicePatchBody } from "./dto.js";

/** The body of the excluded `POST /devices/:id/policy` route (human-only). */
export { DevicePolicyBody } from "./dto.js";

/**
 * The devices routes the Platform operations mirror (`check:platform-ops` keys). Changing a
 * device's network policy (`POST /devices/:id/policy`, body {@link DevicePolicyBody}) is a person's
 * act on their own machine and stays excluded, so it has no entry here. `PATCH /devices/:id` takes
 * a cloud device's `tier` too ({@link DevicePatchBody}); `devices.rename` omits it: a person decides
 * their device's sandbox level.
 */
export const DEVICE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/devices" },
  { route: "POST /api/v1/orgs/:orgId/devices", body: DeviceNameBody },
  { route: "GET /api/v1/orgs/:orgId/devices/:id", params: DeviceParams },
  {
    route: "PATCH /api/v1/orgs/:orgId/devices/:id",
    params: DeviceParams,
    body: DevicePatchBody,
  },
  { route: "DELETE /api/v1/orgs/:orgId/devices/:id", params: DeviceParams },
  { route: "POST /api/v1/orgs/:orgId/devices/:id/files/reset", params: DeviceParams },
];
