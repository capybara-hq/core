import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "perm-secrets",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.secrets.get("org", "token"); // FLAG
  },
});
