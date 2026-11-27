import { defineExtension } from "@capybara-hq/plugin-sdk";

export const undeclared = defineExtension({
  name: "perm-conversations",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.conversations.bySubject({ orgId: "o", subject: { kind: "item", id: "1" } }); // FLAG
  },
});

export const declared = defineExtension({
  name: "perm-conversations-ok",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { conversations: { subjects: true } },
  setup(ctx) {
    void ctx.conversations.bySubject({ orgId: "o", subject: { kind: "item", id: "1" } });
  },
});
