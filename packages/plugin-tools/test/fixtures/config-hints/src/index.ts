// Fixture: valid, fully labelled config UI hints at both levels (packs; config forms check green).
import { defineExtension, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "fixture-config-hints",
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
              baseUrl: ui(z.string(), { label: { zh: "地址", en: "Base URL" }, widget: "url" }),
            }),
          )
          .default([]),
        {
          label: { zh: "端点", en: "Endpoints" },
          item: { title: "{name}" },
          presets: [
            {
              id: "local",
              label: { zh: "本地", en: "Local" },
              values: { name: "local", baseUrl: "http://localhost:8000" },
            },
          ],
          secrets: [{ path: "apiKeys", keyBy: "name", label: { zh: "密钥", en: "API key" } }],
        },
      ),
      apiKeys: secret(z.record(z.string(), z.string()).optional()),
    }),
    org: z.object({
      mode: ui(z.enum(["fast", "slow"]).default("fast"), {
        label: { zh: "模式", en: "Mode" },
        widget: "radio",
        options: [
          { value: "fast", label: { zh: "快", en: "Fast" } },
          { value: "slow", label: { zh: "慢", en: "Slow" } },
        ],
      }),
    }),
  },
  setup() {},
});
