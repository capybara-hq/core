import { defineExtension, type TriggerEvent } from "@capybara-hq/plugin-sdk";

const event: TriggerEvent = {
  orgId: "o",
  type: "item.created",
  subject: { kind: "item", id: "1", title: "One" },
  facts: {},
  summary: "Item one was created.",
  dedupeKey: "item-1-created",
};

export const undeclared = defineExtension({
  name: "perm-triggers",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.triggers.emit(event); // FLAG
  },
});

export const declared = defineExtension({
  name: "perm-triggers-ok",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { triggers: { emit: ["item.created"] } },
  setup(ctx) {
    void ctx.triggers.emit(event);
  },
});
