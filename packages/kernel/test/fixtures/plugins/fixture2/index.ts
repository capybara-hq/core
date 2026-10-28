import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "fixture-two",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["counter@1"],
  setup(ctx) {
    ctx.provide("counter@1", { kind: "two" });
  },
});
