// Red fixture (plugin-org-url-net): an overridable endpoint declared as a plain string, so it
// dodges the URL rule by its type.
import { defineExtension, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "fixture-org-url-named",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["web-search@1"],
  config: {
    deployment: z.object({
      apiEndpoint: ui(z.string().default("https://api.example.com"), {
        label: { zh: "接口地址", en: "API endpoint" },
      }),
    }),
  },
  setup() {},
});
