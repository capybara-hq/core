import { secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** Route parameters of the overrides and tool switch routes (decision R20). */
export const OrgExtensionParams = z.object({ extension: z.string().min(1).max(64) });
export const OrgExtensionToolParams = OrgExtensionParams.extend({
  tool: z.string().min(1).max(64),
});

export const OrgToolSwitchPut = z
  .object({
    enabled: z.boolean(),
    /** The hash of the switch-off preview, to confirm turning the tool off. */
    confirm: z.string().min(1).max(128).optional(),
  })
  .strict();

/** `PUT /orgs/:orgId/extensions/:extension`: enablement and / or the org config. */
export const OrgExtensionPut = z
  .object({
    enabled: z.boolean().optional(),
    /** The whole org config: secret fields omitted keep, `null` clears, a value sets. */
    config: z.record(z.string(), z.unknown()).optional(),
    force: z.boolean().optional(),
    /** The hash of the plugin uninstall preview, to confirm switching the extension's plugin off. */
    confirm: z.string().optional(),
  })
  .strict();

/**
 * One key of a secret record of the org's copy. `value` is a secret (`secret()` meta): a Platform
 * operation never takes it as a param (`platform-op-secret-param`).
 */
export const OrgOverrideSecretEntry = z
  .object({
    /** A secret record field of the copy some `x-ui.secrets[].path` names. */
    path: z.string().min(1).max(256),
    key: z.string().min(1).max(256),
    /** A string sets the key, `null` removes it. */
    value: secret(z.string().max(65_536).nullable().optional()),
    /** Moves the value at this key to `key` first. */
    renameFrom: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine((e) => e.value !== undefined || e.renameFrom !== undefined, {
    message: "an entry needs value or renameFrom",
  })
  .refine((e) => e.key !== "__proto__" && e.renameFrom !== "__proto__", {
    message: "__proto__ is not a valid key",
  });

/** `PUT …/overrides`: overridable fields of the org's copy. */
export const OrgOverridesPut = z
  .object({
    /** Overridable field dot path -> new value (`null` clears); secret fields too. */
    values: z.record(z.string().min(1).max(256), z.unknown()),
    secretEntries: z.array(OrgOverrideSecretEntry).max(200).optional(),
  })
  .strict();

/** `POST …/overrides/take`: the non-secret fields to take from the platform. */
export const OrgOverridesTake = z
  .object({ paths: z.array(z.string().min(1).max(256)).min(1).max(200) })
  .strict();

export const ORG_EXTENSION_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/orgs/:orgId/extensions" },
  { route: "GET /api/v1/orgs/:orgId/extensions/:extension/tools", params: OrgExtensionParams },
  {
    route: "PUT /api/v1/orgs/:orgId/extensions/:extension/tools/:tool",
    params: OrgExtensionToolParams,
    body: OrgToolSwitchPut,
  },
  {
    route: "PUT /api/v1/orgs/:orgId/extensions/:extension",
    params: OrgExtensionParams,
    body: OrgExtensionPut,
  },
  { route: "GET /api/v1/orgs/:orgId/extensions/:extension/overrides", params: OrgExtensionParams },
  {
    route: "PUT /api/v1/orgs/:orgId/extensions/:extension/overrides",
    params: OrgExtensionParams,
    body: OrgOverridesPut,
  },
  {
    route: "DELETE /api/v1/orgs/:orgId/extensions/:extension/overrides",
    params: OrgExtensionParams,
  },
  {
    route: "POST /api/v1/orgs/:orgId/extensions/:extension/overrides/take",
    params: OrgExtensionParams,
    body: OrgOverridesTake,
  },
];
