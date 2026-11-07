// Red fixture: a deployment field an org may override, but no entry point carries per-call config.
import { defineExtension, orgAccess, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "fixture-org-override-unbound",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      region: orgAccess(
        ui(z.string().default("eu"), { label: { zh: "区域", en: "Region" } }),
        "override",
      ),
    }),
  },
  setup() {},
});
