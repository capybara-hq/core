// Violations (plugin-config-labels): a public plugin whose rendered config fields lack a zh + en
// label (`timeout`, `endpoints.items.url`, the org `region`). `apiKeys` is a secret record drawn
// per endpoint by `x-ui.secrets` (with its own label), so it needs none.
import { defineExtension, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "fixture-config-labels",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      endpoints: ui(
        z
          .array(
            z.object({
              name: ui(z.string(), { label: { zh: "名称", en: "Name" } }),
              url: z.string(),
            }),
          )
          .default([]),
        {
          label: { zh: "端点", en: "Endpoints" },
          secrets: [{ path: "apiKeys", keyBy: "name", label: { zh: "密钥", en: "API key" } }],
        },
      ),
      apiKeys: secret(z.record(z.string(), z.string()).optional()),
      timeout: z.number().optional(),
    }),
    org: z.object({
      region: ui(z.string().optional(), { help: { zh: "部署区域。", en: "The region." } }),
    }),
  },
  setup() {},
});
