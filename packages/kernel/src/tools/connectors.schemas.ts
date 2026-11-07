import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/**
 * A credential value: `Credentials.validate` checks its shape by auth method (values are never
 * echoed); this only bounds its size.
 */
export const CredentialValue = z
  .record(z.string().max(100), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 16_384, { message: "Credential is too large" });

/** `:connectorId` as the routes take it (`@Param`). */
export const ConnectorPathParams = z.object({ connectorId: z.string().min(1) });

export const CONNECTOR_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/connectors" },
  { route: "GET /api/v1/orgs/:orgId/connectors/:connectorId", params: ConnectorPathParams },
  { route: "DELETE /api/v1/orgs/:orgId/connectors/:connectorId", params: ConnectorPathParams },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/refresh",
    params: ConnectorPathParams,
  },
];
