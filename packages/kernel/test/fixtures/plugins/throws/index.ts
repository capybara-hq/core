import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "thrower",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup() {
    throw new Error("boom");
  },
});
