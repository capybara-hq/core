import { defineExtension, platformOnly } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** A required platform-only field: without it the extension waits for configuration. */
export default defineExtension({
  name: "badconfig",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: { deployment: z.object({ port: platformOnly(z.number()) }) },
  setup() {},
});
