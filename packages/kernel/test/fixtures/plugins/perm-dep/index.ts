import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 权限快照测试：必需依赖 counter@1（只由 perm-a 提供）。 */
export default definePlugin({
  name: "perm-dep",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  requires: ["counter@1"],
  setup() {},
});
