import { defineExtension } from "@capybara-hq/plugin-sdk";

declare const ids: string[];
const check = { place: "channel", run: async () => ({ status: "ok" as const }) };

export default defineExtension({
  name: "perm-setup-check-dynamic",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { setupChecks: ["bot-token", "bot-scopes"] },
  setup(ctx) {
    ctx.setup.check(ids[0] as string, check); // FLAG
    // capybara:allow-dynamic-permission ids are the declared checks, fixed at build time
    ctx.setup.check(ids[1] as string, check);
    const s = ctx.setup; // FLAG
    void s;
    // capybara:allow-dynamic-permission
    ctx.setup.check(ids[2] as string, check);
  },
});
