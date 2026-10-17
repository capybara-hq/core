import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 提供 counter@1，供 dep-b 依赖（用于验证关闭顺序）。 */
export default definePlugin({
  name: "dep-a",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  setup(ctx) {
    ctx.provide("counter@1", { kind: "dep-a" });
  },
});
