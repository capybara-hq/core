// Violations (plugin-config-ui): a switch widget on a string field (validateConfigUi), and options
// on a secret, which configJsonSchema drops before validation could see them.
import { defineExtension, secret, ui } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

const label = { zh: "字段", en: "Field" };

export default defineExtension({
  name: "fixture-config-ui",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      mode: ui(z.string().optional(), { label, widget: "switch" }),
      token: ui(secret(z.enum(["a", "b"]).optional()), {
        label,
        options: [{ value: "a", label }],
      }),
    }),
    org: z.object({ fine: ui(z.string().optional(), { label }) }),
  },
  setup() {},
});
