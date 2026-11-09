import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { CatalogIdPathParams } from "./admin-catalog.schemas.js";
import { OrgExtensionParams } from "./org-extension.schemas.js";

/**
 * The body of both "apply this plugin's appearance" routes (client extensions spec §6.5):
 * `dryRun: true` answers what would change and writes nothing (the confirm dialog's preview).
 */
export const AppearanceApplyBody = z.object({ dryRun: z.boolean().optional() }).strict();

export const APPEARANCE_ROUTES: readonly RouteSchemas[] = [
  {
    route: "POST /api/v1/admin/catalog/items/:id/appearance",
    params: CatalogIdPathParams,
    body: AppearanceApplyBody,
  },
  {
    route: "POST /api/v1/orgs/:orgId/extensions/:extension/appearance",
    params: OrgExtensionParams,
    body: AppearanceApplyBody,
  },
];
