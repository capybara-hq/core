import { defineExtension, platformOnly, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Version 0.2.0 of the `orglevels` test plugin (spec A §5.2, a level change at upgrade): `baseUrl`
 * is now platform-only, and `apiKey` needs at least 12 characters, so an org copy holding a shorter
 * key becomes invalid. Two platform-only fields carry non-idempotent transforms (`host` gains a
 * "!", `tags` splits into an array), so a config parsed twice shows it. Packed and installed as an
 * upgrade of `orglevels`.
 */
export default defineExtension({
  name: "orglevels",
  version: "0.2.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {},
  config: {
    deployment: z.object({
      host: platformOnly(z.string().transform((s) => `${s}!`)),
      tags: platformOnly(
        z
          .string()
          .default("a,b")
          .transform((s) => s.split(",")),
      ),
      limit: z.number().default(5),
      baseUrl: platformOnly(z.string().url()),
      apiKey: secret(z.string().min(12)),
    }),
  },
  setup() {},
});
