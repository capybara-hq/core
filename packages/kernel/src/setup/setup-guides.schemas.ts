import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `GET /orgs/:orgId/setup-guides`: the language of the guide titles (zh falls back to en). */
export const SetupGuidesQuery = z.object({ locale: z.enum(["en", "zh"]).optional() }).strict();

export const SETUP_GUIDE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/setup-guides", query: SetupGuidesQuery },
];
