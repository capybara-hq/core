import { definePlugin } from "@capybara-hq/plugin-sdk";

/** setup 抛错；host.test 让它的 ctx.close() 也失败，验证宿主记 warn。 */
export default definePlugin({
  name: "closefail",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  setup() {
    throw new Error("setup boom");
  },
});
