import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { CATALOG_LIST_MAX_LIMIT } from "./catalog.service.js";

export const CatalogHash = z.string().min(1).max(128);

export const CatalogItemsQuery = z.object({
  includeDeleted: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(CATALOG_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  /** `true`: only the items waiting for a permission confirmation (not paged). */
  pending: z.enum(["true", "false"]).optional(),
});

const CatalogVersion = z.string().min(1).max(256);
export const CatalogUpdatePreviewBody = z.object({ version: CatalogVersion }).strict();
export const CatalogUpdateBody = z
  .object({ version: CatalogVersion, diffHash: CatalogHash })
  .strict();

/** `:id` as the routes take it (`@Param`). */
export const CatalogIdPathParams = z.object({ id: z.string().min(1) });

export const ADMIN_CATALOG_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/catalog/items", query: CatalogItemsQuery },
  { route: "GET /api/v1/admin/catalog/items/:id", params: CatalogIdPathParams },
  {
    route: "POST /api/v1/admin/catalog/items/:id/update/preview",
    params: CatalogIdPathParams,
    body: CatalogUpdatePreviewBody,
  },
  {
    route: "PUT /api/v1/admin/catalog/items/:id/update",
    params: CatalogIdPathParams,
    body: CatalogUpdateBody,
  },
];
