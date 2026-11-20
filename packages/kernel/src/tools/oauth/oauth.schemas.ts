import { z } from "zod";
import type { RouteSchemas } from "../../platform/route-schemas.js";
import { ConnectorPathParams } from "../connectors.schemas.js";
import { isSafeReturnPath } from "./flow-paths.js";

/**
 * `POST …/connectors/:connectorId/connect`: where the browser returns after the authorization (a
 * relative path on this site; default the connections page).
 */
export const OAuthConnectBodySchema = z
  .object({
    returnTo: z
      .string()
      .max(500)
      .refine(isSafeReturnPath, { message: "returnTo must be a relative path on this site" })
      .optional(),
  })
  .strict();

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
