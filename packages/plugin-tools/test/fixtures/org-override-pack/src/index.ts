// Fixture: a deployment config with an org override field (packs with x-org).
import { defineExtension, orgAccess, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "fixture-org-override-pack",
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
