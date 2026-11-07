import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

export const ExtensionPointParams = z.object({ point: z.string().min(1).max(100) });
export const ExtensionPointDefaultBody = z
  .object({ extension: z.string().min(1).max(214) })
  .strict();

export const EXTENSION_POINT_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/extension-points" },
  { route: "GET /api/v1/orgs/:orgId/extension-points/available" },
  {
    route: "PUT /api/v1/orgs/:orgId/extension-points/:point/default",
    params: ExtensionPointParams,
    body: ExtensionPointDefaultBody,
  },
];
