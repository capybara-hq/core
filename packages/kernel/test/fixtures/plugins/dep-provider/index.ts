import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 测试用（T26 应用卸载顺序）：提供按组织启用的 channel@1，被 dep-requirer 依赖。 */
export default defineExtension({
  name: "dep-provider",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", { id: "dep" });
  },
});
