import { defineExtension, orgAccess } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Deployment schema whose overridable field is wrapped after `orgAccess` (`.default()`), the way
 * authors naturally write it: the kernel must still read it as `override`.
 */
export const OrgwrappedDeploymentSchema = z.object({
  host: z.string(),
  region: orgAccess(z.string(), "override").default("eu"),
});

/** Test plugin with a wrapped overridable field; it registers nothing. */
export default defineExtension({
  name: "orgwrapped",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {},
  config: { deployment: OrgwrappedDeploymentSchema },
  setup() {},
});
