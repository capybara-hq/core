import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 权限快照测试：可选依赖 counter@1；提供方不加载时照常加载。 */
export default defineExtension({
  name: "perm-opt",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  optional: ["counter@1"],
  setup() {},
});
