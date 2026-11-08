import { z } from "zod";
import { MARKETPLACE_MAX_MIRRORS } from "../config/schema.js";
import type { RouteSchemas } from "../platform/route-schemas.js";

export const MarketplaceUrl = z.string().min(1).max(2000);

export const MarketplaceForm = z.enum(["http", "git"]);
export const MarketplaceRef = z.string().min(1).max(256);

export const MarketplaceAddBody = z.object({
  name: z.string().min(1).max(100),
  url: MarketplaceUrl,
  form: MarketplaceForm.optional(),
  ref: MarketplaceRef.optional(),
  mirrors: z.array(MarketplaceUrl).max(MARKETPLACE_MAX_MIRRORS).optional(),
  token: z.string().min(1).max(4096).optional(),
});

export const MarketplaceEntriesQuery = z.object({
  sourceId: z.string().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
});

export const MARKETPLACE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/marketplaces" },
  { route: "POST /api/v1/admin/marketplaces", body: MarketplaceAddBody },
  { route: "GET /api/v1/orgs/:orgId/marketplaces/entries", query: MarketplaceEntriesQuery },
];
