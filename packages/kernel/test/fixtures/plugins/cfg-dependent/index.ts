import { defineExtension, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * A config-declared extension that requires counter@1 (from dep-a) and needs a deployment config
 * (`endpoint` required, `token` a secret): unloaded for a dependency, it must come back on the
 * config stored now, never on the one it was loaded with.
 */
export default defineExtension({
  name: "cfg-dependent",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  requires: ["counter@1"],
  config: {
    deployment: z.object({ endpoint: z.string().min(1), token: secret(z.string()).optional() }),
  },
  setup() {},
});
