// Red fixture (plugin-org-url-net): an overridable URL that reaches the network through the global
// fetch, so an org could point the extension at a private address.
import { defineExtension, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

const deployment = z.object({
  baseUrl: ui(z.url().default("https://api.example.com"), {
    label: { zh: "地址", en: "Base URL" },
  }),
});

export default defineExtension({
  name: "fixture-org-url-unrouted",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["web-search@1"],
  config: { deployment },
  setup(ctx) {
    ctx.provide("web-search@1", {
      async search(_q: string, opts: { config: z.infer<typeof deployment> }) {
        return fetch(`${opts.config.baseUrl}/search`);
      },
    });
  },
});
