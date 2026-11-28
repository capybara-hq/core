import { defineExtension } from "@capybara-hq/plugin-sdk";

export const undeclared = defineExtension({
  name: "perm-agents",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.agents.usableBy({ orgId: "o", accountId: "a" }); // FLAG
  },
});

export const declared = defineExtension({
  name: "perm-agents-ok",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { agents: { read: true } },
  setup(ctx) {
    void ctx.agents.usableBy({ orgId: "o", accountId: "a" });
  },
});
