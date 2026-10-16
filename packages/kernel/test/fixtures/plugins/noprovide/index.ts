import { definePlugin } from "@capybara-hq/plugin-sdk";

export default definePlugin({
  name: "noprovide",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  setup() {},
});
