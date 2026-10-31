import { defineExtension, MODEL_PROVIDER_EXTENSION_POINT_V2 } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** Required deployment config: without `apiKey` the extension is pending configuration. */
const Config = z.object({ apiKey: z.string().min(1) });

/**
 * A model provider that needs configuration before it loads (the readiness tests: a provider
 * pending configuration does not make the org ready). `listModels` throws: readiness must never
 * call the vendor.
 */
export default defineExtension({
  name: "model-needs-config",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  config: { deployment: Config },
  setup(ctx) {
    Config.parse(ctx.config ?? {});
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, {
      async listModels() {
        throw new Error("the vendor is down");
      },
      async *stream() {
        throw new Error("the vendor is down");
      },
    });
  },
});
