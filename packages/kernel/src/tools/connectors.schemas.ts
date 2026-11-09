import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/**
 * A credential value: `Credentials.validate` checks its shape by auth method (values are never
 * echoed); this only bounds its size.
 */
export const CredentialValue = z
  .record(z.string().max(100), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 16_384, { message: "Credential is too large" });

/** 「我已更新应用」: the admin drift hash of the connector template guide the person was shown. */
export const ConnectorGuideAckSchema = z
  .object({ hash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

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

/**
 * `PUT …/connectors/:connectorId/tool-policies/me`: the caller's own policy per tool name (null
 * clears it; decision 2026-11-09).
 */
export const MemberToolPoliciesBody = z
  .object({
    tools: z
      .record(z.string().min(1).max(200), z.enum(["allow", "ask", "deny"]).nullable())
      .refine((v) => Object.keys(v).length <= 1000, { message: "Too many tools" }),
  })
  .strict();
