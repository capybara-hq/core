// Red fixture (plugin-config-unbound): a channel extension (no tool, ui, hook or org-bound point)
// with an unmarked deployment field, which no per-call config would ever carry.
import { defineExtension, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "fixture-config-unbound",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  config: {
    deployment: z.object({
      region: ui(z.string().default("eu"), { label: { zh: "区域", en: "Region" } }),
    }),
  },
  setup() {},
});
