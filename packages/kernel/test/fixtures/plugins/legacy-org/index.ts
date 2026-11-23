import {
  defineExtension,
  type ExtensionManifest,
  orgAccess,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * A module as packed before core#720: overridable fields marked with `orgAccess` and an org-only
 * `config.org` schema. The cast stands for the JavaScript bundle, which no type check sees.
 */
export default defineExtension({
  name: "legacy-org",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      apiKey: orgAccess(secret(z.string().min(1)), "override"),
      region: orgAccess(z.string().default("cn"), "readonly"),
    }),
    org: z.object({ orgToken: secret(z.string()), orgOnly: z.string().optional() }),
  },
  setup() {},
} as unknown as ExtensionManifest);
