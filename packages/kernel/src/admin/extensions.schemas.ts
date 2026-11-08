import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `:name` as the lifecycle and detail routes take it (`@Param`). */
export const AdminExtensionNamePathParams = z.object({ name: z.string().min(1) });

export const ADMIN_EXTENSION_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/extensions" },
  { route: "GET /api/v1/admin/extensions/:name", params: AdminExtensionNamePathParams },
  { route: "POST /api/v1/admin/extensions/:name/enable", params: AdminExtensionNamePathParams },
  { route: "POST /api/v1/admin/extensions/:name/disable", params: AdminExtensionNamePathParams },
  { route: "DELETE /api/v1/admin/extensions/:name", params: AdminExtensionNamePathParams },
];
