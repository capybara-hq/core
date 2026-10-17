import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 依赖 dep-a 提供的 counter@1：拓扑序中排在 dep-a 之后。 */
export default definePlugin({
  name: "dep-b",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  requires: ["counter@1"],
  setup() {},
});
