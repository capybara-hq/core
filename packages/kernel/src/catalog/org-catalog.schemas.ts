import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { CredentialValue } from "../tools/connectors.schemas.js";

export const CatalogRequestBody = z
  .object({
    kind: z.enum(["access", "enable"]),
    note: z.string().max(1000).optional(),
  })
  .strict();

/** An org admin's request for a marketplace entry not in the catalog yet. */
export const CatalogMarketplaceRequestBody = z
  .object({
    marketplaceId: z.string().min(1).max(100),
    name: z.string().min(1).max(214),
    version: z.string().min(1).max(256),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const CatalogConnectorInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: z.string().max(24).optional(),
    endpoint: z.record(z.string(), z.unknown()).optional(),
    credential: CredentialValue.optional(),
    client: z
      .object({
        clientId: z.string().min(1).max(500),
        clientSecret: z.string().min(1).max(4000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The org install body: template input, the extension's org config. No version: an org installs the
 * platform version (one per deployment, ruling P2-17).
 */
export const OrgPluginInstallBody = z
  .object({
    connectors: z.record(z.string(), CatalogConnectorInput).optional(),
    extensionConfig: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** The switch body: on (with the install inputs), or off (with the preview's hash to confirm). */
export const OrgPluginSwitchBody = z
  .object({
    enabled: z.boolean(),
    inputs: OrgPluginInstallBody.optional(),
    confirm: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

/** `:itemId` as the routes take it (`@Param`). */
export const CatalogItemPathParams = z.object({ itemId: z.string().min(1) });

/** `:installId` as the uninstall route takes it (`@Param`). */
export const PluginInstallPathParams = z.object({ installId: z.string().min(1) });

/** The super admin's request list filter. */
export const CatalogRequestsListQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
});

export const ORG_CATALOG_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/catalog" },
  { route: "GET /api/v1/orgs/:orgId/catalog/:itemId", params: CatalogItemPathParams },
  {
    route: "POST /api/v1/orgs/:orgId/catalog/:itemId/requests",
    params: CatalogItemPathParams,
    body: CatalogRequestBody,
  },
  { route: "POST /api/v1/orgs/:orgId/marketplace-requests", body: CatalogMarketplaceRequestBody },
  {
    route: "PUT /api/v1/orgs/:orgId/catalog/:itemId/switch",
    params: CatalogItemPathParams,
    body: OrgPluginSwitchBody,
  },
  { route: "GET /api/v1/orgs/:orgId/plugin-installs" },
  {
    route: "DELETE /api/v1/orgs/:orgId/plugin-installs/:installId",
    params: PluginInstallPathParams,
  },
  { route: "GET /api/v1/admin/catalog/requests", query: CatalogRequestsListQuery },
];
