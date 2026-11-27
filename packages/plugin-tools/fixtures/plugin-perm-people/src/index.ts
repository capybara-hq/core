import { defineExtension } from "@capybara-hq/plugin-sdk";

export const undeclared = defineExtension({
  name: "perm-people",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.people.get({ orgId: "o", accountIds: ["a"] }); // FLAG
  },
});

export const declared = defineExtension({
  name: "perm-people-ok",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { people: { read: true } },
  setup(ctx) {
    void ctx.people.get({ orgId: "o", accountIds: ["a"] });
  },
});
