import { defineExtension, platformOnly } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Deployment schema whose platform-only field is wrapped after `platformOnly` (`.optional()`), the
 * way authors naturally write it: the kernel must still read it as `platform`. `region` (with a
 * default) is overridable.
 */
export const OrgwrappedDeploymentSchema = z.object({
  host: platformOnly(z.string()).optional(),
  region: z.string().default("eu"),
});

/** Test plugin with a wrapped platform-only field; it registers nothing. */
export default defineExtension({
  name: "orgwrapped",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {},
  config: { deployment: OrgwrappedDeploymentSchema },
  setup() {},
});
