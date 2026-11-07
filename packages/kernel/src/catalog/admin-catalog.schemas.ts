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

/** `:stagingId` of a staged import as the route takes it (`@Param`). */
export const CatalogStagingPathParams = z.object({ stagingId: z.string().min(1) });

export const CatalogNpmImportBody = z.object({
  package: z.string().min(1).max(214),
  version: z.string().min(1).max(256).optional(),
});

export const CatalogGitImportBody = z
  .object({
    url: z.string().min(1).max(2000),
    ref: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(512).optional(),
  })
  .strict();

export const CatalogScope = z.enum(["all", "optional", "named"]);
export const CatalogScopeOrgs = z.array(z.string().min(1).max(128)).max(1000);

/** `{ scope, orgs? }` (a scope change) or `{ disabled: true }` (a disable), not both. */
export const CatalogScopePreviewBody = z
  .object({
    scope: CatalogScope.optional(),
    orgs: CatalogScopeOrgs.optional(),
    disabled: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => (b.disabled === true) !== (b.scope !== undefined), {
    message: "send either scope (with orgs for named) or disabled: true",
  })
  .refine((b) => b.disabled === undefined || b.orgs === undefined, {
    message: "orgs: only allowed with scope named",
    path: ["orgs"],
  });

export const CatalogScopeBody = z
  .object({ scope: CatalogScope, orgs: CatalogScopeOrgs.optional(), scopeHash: CatalogHash })
  .strict();

export const CatalogDisabledBody = z
  .object({ disabled: z.boolean(), scopeHash: CatalogHash.optional() })
  .strict();
export const CatalogShownBody = z.object({ shownToOthers: z.boolean() }).strict();

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
  { route: "POST /api/v1/admin/catalog/import/npm", body: CatalogNpmImportBody },
  { route: "POST /api/v1/admin/catalog/import/git", body: CatalogGitImportBody },
  { route: "GET /api/v1/admin/catalog/imports/:stagingId", params: CatalogStagingPathParams },
  {
    route: "POST /api/v1/admin/catalog/items/:id/scope/preview",
    params: CatalogIdPathParams,
    body: CatalogScopePreviewBody,
  },
  {
    route: "PUT /api/v1/admin/catalog/items/:id/scope",
    params: CatalogIdPathParams,
    body: CatalogScopeBody,
  },
  {
    route: "PUT /api/v1/admin/catalog/items/:id/disabled",
    params: CatalogIdPathParams,
    body: CatalogDisabledBody,
  },
  {
    route: "PUT /api/v1/admin/catalog/items/:id/shown",
    params: CatalogIdPathParams,
    body: CatalogShownBody,
  },
  { route: "DELETE /api/v1/admin/catalog/items/:id", params: CatalogIdPathParams },
];
