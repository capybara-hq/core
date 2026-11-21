import { GIT_USERNAME_RE } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { MARKETPLACE_MAX_MIRRORS } from "../config/schema.js";
import type { RouteSchemas } from "../platform/route-schemas.js";

export const MarketplaceUrl = z.string().min(1).max(2000);

export const MarketplaceForm = z.enum(["http", "git"]);
export const MarketplaceRef = z.string().min(1).max(256);
/**
 * The Basic auth username sent with a git marketplace's token (`GIT_USERNAME_RE`; empty: the
 * default `x-access-token`).
 */
export const MarketplaceUsername = z
  .string()
  .max(64)
  .regex(new RegExp(`^$|${GIT_USERNAME_RE.source}`), {
    message: "username must be empty or match ^[A-Za-z0-9._-]{1,64}$",
  });

export const MarketplaceAddBody = z.object({
  name: z.string().min(1).max(100),
  url: MarketplaceUrl,
  form: MarketplaceForm.optional(),
  ref: MarketplaceRef.optional(),
  mirrors: z.array(MarketplaceUrl).max(MARKETPLACE_MAX_MIRRORS).optional(),
  token: z.string().min(1).max(4096).optional(),
  username: MarketplaceUsername.optional(),
});

export const MarketplaceEntriesQuery = z.object({
  sourceId: z.string().min(1).max(100).optional(),
  q: z.string().max(200).optional(),
});

export const MarketplacePatchBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    url: MarketplaceUrl.optional(),
    form: MarketplaceForm.optional(),
    ref: MarketplaceRef.nullable().optional(),
    mirrors: z.array(MarketplaceUrl).max(MARKETPLACE_MAX_MIRRORS).optional(),
    enabled: z.boolean().optional(),
    token: z.string().min(1).max(4096).nullable().optional(),
    username: MarketplaceUsername.nullable().optional(),
  })
  .strict();

export const MarketplaceImportBody = z.object({ version: z.string().min(1).max(256).optional() });

/** `:id` of a marketplace as the routes take it (`@Param`). */
export const MarketplaceIdPathParams = z.object({ id: z.string().min(1) });
/** `:id` and the entry `:name` of the import route (`@Param`). */
export const MarketplaceEntryPathParams = MarketplaceIdPathParams.extend({
  name: z.string().min(1),
});

export const MARKETPLACE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/marketplaces" },
  { route: "POST /api/v1/admin/marketplaces", body: MarketplaceAddBody },
  { route: "GET /api/v1/orgs/:orgId/marketplaces/entries", query: MarketplaceEntriesQuery },
  { route: "GET /api/v1/admin/marketplaces/entries", query: MarketplaceEntriesQuery },
  {
    route: "PATCH /api/v1/admin/marketplaces/:id",
    params: MarketplaceIdPathParams,
    body: MarketplacePatchBody,
  },
  { route: "DELETE /api/v1/admin/marketplaces/:id", params: MarketplaceIdPathParams },
  { route: "POST /api/v1/admin/marketplaces/:id/refresh", params: MarketplaceIdPathParams },
  {
    route: "POST /api/v1/admin/marketplaces/:id/entries/:name/import",
    params: MarketplaceEntryPathParams,
    body: MarketplaceImportBody,
  },
];
