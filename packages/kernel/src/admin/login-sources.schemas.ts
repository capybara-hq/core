import { z } from "zod";
import { MAX_TRUSTED_TENANTS, TENANT_MAX } from "../identity/login-sources.js";
import type { RouteSchemas } from "../platform/route-schemas.js";

/** A plugin name as the extension host takes it (the npm package name limit). */
const PluginName = z
  .string()
  .min(1)
  .max(214)
  .describe("The plugin name of an extension providing identity-source@1, e.g. slack.");

/** `PUT /api/v1/admin/login-sources/:plugin`. */
export const LoginSourceParams = z.object({ plugin: PluginName });

/**
 * `PUT /api/v1/admin/login-sources/:plugin`: the fields to change (login extensions spec §1); a
 * field left out keeps its value. The service trims, de-duplicates and checks the tenants
 * against the source's tenant declaration (`login_sources.invalid_tenant`).
 */
export const LoginSourceBody = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe(
        "Whether the login page offers this sign-in; turning it on puts it last in the login page order.",
      ),
    signUp: z
      .enum(["link", "create"])
      .optional()
      .describe(
        "An external account nobody has linked: link (the link page, where the person signs in with a username and password to link it) or create (a new account is created).",
      ),
    trustedTenants: z
      .array(z.string().max(TENANT_MAX))
      .max(MAX_TRUSTED_TENANTS)
      .optional()
      .describe(
        "The whole list of tenant ids (e.g. a Slack workspace id) whose verified emails link to the existing account with that email; [] trusts none.",
      ),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "at least one field is required" });

/** `PUT /api/v1/admin/login-sources/order`: the login page order. */
export const LoginSourcesOrderBody = z.object({
  plugins: z
    .array(PluginName)
    .max(100)
    .describe("Every enabled login source exactly once, in the order the login page shows them."),
});

/** The super admin's login sources routes. */
export const LOGIN_SOURCE_ROUTES: readonly RouteSchemas[] = [
  { route: "GET /api/v1/admin/login-sources" },
  { route: "PUT /api/v1/admin/login-sources/order", body: LoginSourcesOrderBody },
  {
    route: "PUT /api/v1/admin/login-sources/:plugin",
    params: LoginSourceParams,
    body: LoginSourceBody,
  },
];
