// Fixture: a deployment config with a platform-only field (packs with x-platform-only).
import { defineExtension, platformOnly, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "fixture-platform-only-pack",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      region: platformOnly(ui(z.string().default("eu"), { label: { zh: "区域", en: "Region" } })),
    }),
  },
  setup() {},
});
