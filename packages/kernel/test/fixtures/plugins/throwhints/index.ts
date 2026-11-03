import { defineExtension } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * A hand-made extension whose deployment config hints make the form conversion throw (a BigInt in
 * the `ui` meta cannot be copied as JSON): the hint check must not throw out of the load, so the
 * extension still loads and gets its status row.
 */
export default defineExtension({
  name: "throwhints",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: {
    deployment: z.object({
      mode: z
        .string()
        .default("a")
        .meta({ ui: { label: { zh: "模式", en: "Mode" }, big: 1n } }),
    }),
  },
  setup() {},
});
