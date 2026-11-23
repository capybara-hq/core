import { defineExtension, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * An extension whose deployment config has org-overridable fields (required ones the platform may
 * leave empty, secret fields, one nested in an object): orgs that follow an empty platform config
 * need their own copy (`needsConfig`).
 */
export default defineExtension({
  name: "orgcfg",
  version: "1.2.3",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      appId: z.string(),
      appSecret: secret(z.string()),
      webhook: z
        .object({
          token: secret(z.string()).optional(),
          path: z.string().default("/hook"),
        })
        .prefault({}),
    }),
  },
  setup() {},
});
