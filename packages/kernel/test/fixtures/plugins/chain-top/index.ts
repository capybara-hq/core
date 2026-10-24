import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 延后加载链的顶端：requires counter@2（由 chain-mid 提供）；setup 时取不到就抛错。 */
export default definePlugin({
  name: "chain-top",
  version: "0.1.0",
  sdk: "^0.1.0",
  requires: ["counter@2"],
  provides: [],
  setup(ctx) {
    if ((ctx.capabilities.list("counter@2") as unknown[]).length === 0) {
      throw new Error("counter@2 has no provider");
    }
  },
});
