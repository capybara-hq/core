import { definePlugin } from "@capybara-hq/plugin-sdk";

export default definePlugin({
  name: "perm-reserved",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: { storage: true },
  setup(ctx) {
    void ctx.storage; // FLAG
    void ctx.models; // FLAG
  },
});
