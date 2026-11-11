import { z } from "zod";
import { MAX_PASSWORD_LENGTH } from "../identity/login.js";
import { DEPLOYMENT_SETTINGS_PATCH } from "../identity/settings.js";
import { ModelDisabledPatch, ModelProviderParams } from "../models/enablement.controller.js";
import { MODEL_PRICE_PUT } from "../models/prices.js";
import { PURPOSE_PUT } from "../models/purposes.js";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `GET /api/v1/admin/accounts`: keyset paging by account id. */
export const AccountListQuery = z.object({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const CreateAccountBody = z.object({
  login: z.string().min(1).max(64),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  displayName: z.string().trim().min(1).max(100),
  email: z.email().max(254).optional(),
  superAdmin: z.boolean().optional(),
});

export const AccountParams = z.object({ accountId: z.string().min(1).max(100) });

export const UpdateAccountBody = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  isSuperAdmin: z.boolean().optional(),
});

/** At least one key; `runConcurrencyOverrides` merges by org, a null value drops that org's. */
export const DeploymentSettingsBody = DEPLOYMENT_SETTINGS_PATCH.refine(
  (b) => Object.keys(b).length > 0,
  { message: "at least one setting is required" },
);

export const PurposeParams = z.object({ purpose: z.string().min(1).max(100) });

/** `:orgId` of an admin route: any org, the super admin need not be a member. */
export const AdminOrgParams = z.object({ orgId: z.string().min(1).max(100) });

export const ADMIN_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/accounts", query: AccountListQuery },
  { route: "POST /api/v1/admin/accounts", body: CreateAccountBody },
  {
    route: "PATCH /api/v1/admin/accounts/:accountId",
    params: AccountParams,
    body: UpdateAccountBody,
  },
  { route: "GET /api/v1/admin/orgs" },
  // `:orgId` is the conversation's org for the operation, so never an operation field
  { route: "GET /api/v1/admin/orgs/:orgId/members" },
  { route: "GET /api/v1/admin/settings" },
  { route: "PUT /api/v1/admin/settings", body: DeploymentSettingsBody },
  { route: "GET /api/v1/admin/models" },
  {
    route: "PATCH /api/v1/admin/models/:provider/disabled",
    params: ModelProviderParams,
    body: ModelDisabledPatch,
  },
  { route: "GET /api/v1/admin/model-prices" },
  { route: "PUT /api/v1/admin/model-prices", body: MODEL_PRICE_PUT },
  { route: "GET /api/v1/admin/model-purposes" },
  { route: "PUT /api/v1/admin/model-purposes/:purpose", params: PurposeParams, body: PURPOSE_PUT },
];
