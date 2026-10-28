import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 测试用（T26 应用卸载顺序）：requires channel@1（按组织启用），由 dep-provider 提供。 */
export default defineExtension({
  name: "dep-requirer",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  requires: ["channel@1"],
  setup() {},
});
