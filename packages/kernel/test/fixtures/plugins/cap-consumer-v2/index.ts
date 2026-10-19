import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 测试用：requires channel@2。 */
export default definePlugin({
  name: "cap-consumer-v2",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  requires: ["channel@2"],
  setup() {},
});
