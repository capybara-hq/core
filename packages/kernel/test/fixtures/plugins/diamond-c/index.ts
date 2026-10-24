import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 菱形依赖的另一边：optional counter@1，provides identity-source@1（空壳）。 */
export default defineExtension({
  name: "diamond-c",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["identity-source@1"],
  optional: ["counter@1"],
  setup(ctx) {
    ctx.provide("identity-source@1", {});
  },
});
