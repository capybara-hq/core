import { defineExtension } from "@capybara-hq/plugin-sdk";

const APP_TOKEN = "app-token";
const check = { place: "channel", run: async () => ({ status: "ok" as const }) };

export default defineExtension({
  name: "perm-setup-check-undeclared",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { setupChecks: ["bot-token"] },
  setup(ctx) {
    ctx.setup.check("bot-token", check);
    ctx.setup.check("bot-scopes", check); // FLAG
    ctx.setup.check(APP_TOKEN, check); // FLAG
    // capybara:allow-dynamic-permission not exemptible: an explicit violation
    ctx.setup.check("sneaky", check); // FLAG
  },
});
