import { secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** `:name` as the lifecycle and detail routes take it (`@Param`). */
export const AdminExtensionNamePathParams = z.object({ name: z.string().min(1) });

/**
 * One key of a secret record a config UI hint draws per item (extension config forms spec §4.3).
 * `value` is a secret (`secret()` meta): a Platform operation never takes it as a param
 * (`platform-op-secret-param`).
 */
export const AdminExtensionSecretEntry = z
  .object({
    /** A secret record field some `x-ui.secrets[].path` names. */
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

/** `PUT /admin/extensions/:name/config`: the deployment config fields to save. */
export const AdminExtensionConfigBody = z.object({
  /** Field dot path -> new value (`null` clears, omitted keeps). */
  values: z.record(z.string().min(1).max(256), z.unknown()),
  /** Single keys of hinted secret records (extension config forms spec §4.3), applied in order. */
  secretEntries: z.array(AdminExtensionSecretEntry).max(200).optional(),
});

export const ADMIN_EXTENSION_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/extensions" },
  { route: "GET /api/v1/admin/extensions/:name", params: AdminExtensionNamePathParams },
  { route: "POST /api/v1/admin/extensions/:name/enable", params: AdminExtensionNamePathParams },
  { route: "POST /api/v1/admin/extensions/:name/disable", params: AdminExtensionNamePathParams },
  { route: "DELETE /api/v1/admin/extensions/:name", params: AdminExtensionNamePathParams },
  { route: "GET /api/v1/admin/extensions/:name/config", params: AdminExtensionNamePathParams },
  {
    route: "PUT /api/v1/admin/extensions/:name/config",
    params: AdminExtensionNamePathParams,
    body: AdminExtensionConfigBody,
  },
  { route: "DELETE /api/v1/admin/extensions/:name/config", params: AdminExtensionNamePathParams },
];
