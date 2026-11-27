import { z } from "zod";
import { HandoffRequestSchema } from "../../handoff/app-schemes.js";
import type { RouteSchemas } from "../../platform/route-schemas.js";
import { ConnectorPathParams } from "../connectors.schemas.js";
import { isSafeReturnPath } from "./flow-paths.js";

/**
 * `POST …/connectors/:connectorId/connect`: where the browser returns after the authorization (a
 * relative path on this site; default the connections page). `handoff` (a native shell): finish
 * the authorization in the system browser through a handoff ticket instead.
 */
export const OAuthConnectBodySchema = z
  .object({
    returnTo: z
      .string()
      .max(500)
      .refine(isSafeReturnPath, { message: "returnTo must be a relative path on this site" })
      .optional(),
    handoff: HandoffRequestSchema.optional(),
  })
  .strict();

/**
 * The connect route's answer: the authorization URL (the binding cookie is set on this browser),
 * or with `handoff` the web page that starts it in the system browser (no cookie, no state).
 */
export type OAuthConnectResponse = { authorizationUrl: string } | { handoffUrl: string };

/**
 * The connect route's schemas for the Platform parity check (`connectors.connect` mirrors it; the
 * OAuth callback stays an exclusion).
 */
export const OAUTH_ROUTES: readonly RouteSchemas[] = [
  {
    route: "POST /api/v1/orgs/:orgId/connectors/:connectorId/connect",
    params: ConnectorPathParams,
    body: OAuthConnectBodySchema,
  },
];
