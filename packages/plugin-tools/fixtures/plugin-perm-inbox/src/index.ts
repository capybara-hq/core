import { defineExtension, type InboxPost } from "@capybara-hq/plugin-sdk";

const item: InboxPost = {
  orgId: "o",
  accountId: "a",
  kind: "item.assigned",
  title: "CAP-12 was assigned to you",
  link: "/p/perm-inbox/items",
};

export const undeclared = defineExtension({
  name: "perm-inbox",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.inbox.post(item); // FLAG
  },
});

export const declared = defineExtension({
  name: "perm-inbox-ok",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { inbox: true },
  setup(ctx) {
    void ctx.inbox.post(item);
  },
});
