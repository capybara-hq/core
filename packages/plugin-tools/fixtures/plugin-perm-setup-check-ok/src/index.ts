import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";

const BOT_TOKEN = "bot-token";
const check = { place: "channel", run: async () => ({ status: "ok" as const }) };

export default defineExtension({
  name: "perm-setup-check-ok",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { setupChecks: [BOT_TOKEN, "bot-scopes"] },
  setup(ctx) {
    ctx.setup.check("bot-scopes", check);
    ctx.setup.check(BOT_TOKEN, check);
    register(ctx);
  },
});

function register(c: ExtensionContext): void {
  c.setup.check("bot-token", check);
}
