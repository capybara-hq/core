// Green fixture: every overridable URL reaches the network through configUrlFetch, a top-level
// `baseUrl` by member access and a nested `endpoints[].baseUrl` through a destructured binding.
import { configUrlFetch, defineExtension, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

const label = { zh: "地址", en: "Base URL" };

const deployment = z.object({
  baseUrl: ui(z.url().default("https://api.example.com"), { label }),
  endpoints: ui(z.array(z.object({ baseUrl: ui(z.url(), { label }) })).default([]), {
    label: { zh: "端点", en: "Endpoints" },
  }),
});

type Config = z.infer<typeof deployment>;

export default defineExtension({
  name: "fixture-org-url-routed",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["web-search@1"],
  config: { deployment },
  setup(ctx) {
    const platform = () => ctx.config as Config;
    ctx.provide("web-search@1", {
      async search(_q: string, opts: { config: Config; orgId: string }) {
        const { config, orgId } = opts;
        const main = configUrlFetch(ctx.net, {
          url: config.baseUrl,
          platform: platform().baseUrl,
          orgId,
        });
        await main(`${config.baseUrl}/search`);
        for (const { baseUrl } of config.endpoints) {
          const f = configUrlFetch(ctx.net, {
            url: baseUrl,
            platform: platform().endpoints.map((e) => e.baseUrl),
            orgId,
          });
          await f(`${baseUrl}/search`);
        }
      },
    });
  },
});
