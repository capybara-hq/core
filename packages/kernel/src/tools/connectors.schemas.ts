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

/**
 * `PUT …/connectors/:connectorId/git-push-policy`: the org's default for pushes through the
 * connector's credential in sandboxes (the virtual tool `git_push`, sandbox git credentials
 * spec §7).
 */
export const GitPushPolicyBody = z.object({ policy: z.enum(["allow", "ask", "deny"]) }).strict();

export const CONNECTOR_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/connectors" },
  { route: "GET /api/v1/orgs/:orgId/connectors/:connectorId", params: ConnectorPathParams },
  { route: "DELETE /api/v1/orgs/:orgId/connectors/:connectorId", params: ConnectorPathParams },
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/refresh",
    params: ConnectorPathParams,
  },
  {
    route: "PUT /api/v1/orgs/:orgId/connectors/:connectorId/git-push-policy",
    params: ConnectorPathParams,
    body: GitPushPolicyBody,
  },
];

/**
 * `PUT …/connectors/:connectorId/tool-policies/me`: the caller's own policy per tool name (null
 * clears it; decision 2026-11-09). A key may also be a standing push decision
 * `git_push:<host>/<owner>/<repo>` (only cleared), hence the longer bound.
 */
export const MemberToolPoliciesBody = z
  .object({
    tools: z
      .record(z.string().min(1).max(500), z.enum(["allow", "ask", "deny"]).nullable())
      .refine((v) => Object.keys(v).length <= 1000, { message: "Too many tools" }),
  })
  .strict();
