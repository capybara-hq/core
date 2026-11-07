import { z } from "zod";
import { ModelsQuery } from "../agents/models.controller.js";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { ModelDisabledPatch, ModelProviderParams } from "./enablement.controller.js";
import { PURPOSE_PUT } from "./purposes.js";

/** `:purpose` as the org purpose route takes it (`@Param`). */
export const ModelPurposePathParams = z.object({ purpose: z.string().min(1) });

/** The org's model routes (the admin console's are the platform-admin domain's). */
export const ORG_MODEL_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/models", query: ModelsQuery },
  { route: "GET /api/v1/orgs/:orgId/models/catalog" },
  { route: "GET /api/v1/orgs/:orgId/model-purposes" },
  {
    route: "PUT /api/v1/orgs/:orgId/model-purposes/:purpose",
    params: ModelPurposePathParams,
    body: PURPOSE_PUT,
  },
  {
    route: "PATCH /api/v1/orgs/:orgId/models/:provider/disabled",
    params: ModelProviderParams,
    body: ModelDisabledPatch,
  },
];
