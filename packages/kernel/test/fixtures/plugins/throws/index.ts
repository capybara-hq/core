import { definePlugin } from "@capybara-hq/plugin-sdk";

export default definePlugin({
  name: "thrower",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  setup() {
    throw new Error("boom");
  },
});
