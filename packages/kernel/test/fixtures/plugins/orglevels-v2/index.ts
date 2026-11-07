import { defineExtension, orgAccess, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Version 0.2.0 of the `orglevels` test plugin (spec A §5.2, a level change at upgrade): `baseUrl`
 * is no longer overridable (hidden), and `apiKey` now needs at least 12 characters, so an org copy
 * holding a shorter key becomes invalid. Packed and installed as an upgrade of `orglevels`.
 */
export default defineExtension({
  name: "orglevels",
  version: "0.2.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {},
  config: {
    deployment: z.object({
      host: z.string(),
      limit: orgAccess(z.number().default(5), "readonly"),
      baseUrl: z.string().url(),
      apiKey: orgAccess(secret(z.string().min(12)), "override"),
    }),
    org: z.object({ team: z.string().optional() }),
  },
  setup() {},
});
