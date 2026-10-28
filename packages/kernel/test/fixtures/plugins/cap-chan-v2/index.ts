import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 测试用：提供 channel@2（orgScoped），用于核对依赖按主版本匹配。 */
export default defineExtension({
  name: "cap-chan-v2",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@2"],
  setup(ctx) {
    ctx.provide("channel@2", { id: "v2" });
  },
});
