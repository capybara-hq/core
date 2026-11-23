// Green fixture: the same channel extension with its whole deployment schema platform-only.
import { defineExtension, platformOnly, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "fixture-config-bound-clean",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  config: {
    deployment: platformOnly(
      z.object({
        region: ui(z.string().default("eu"), { label: { zh: "区域", en: "Region" } }),
      }),
    ),
  },
  setup() {},
});
