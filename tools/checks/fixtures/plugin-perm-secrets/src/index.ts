import { definePlugin } from "@capybara-hq/plugin-sdk";

export default definePlugin({
  name: "perm-secrets",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx) {
    void ctx.secrets.get("org", "token"); // FLAG
  },
});
