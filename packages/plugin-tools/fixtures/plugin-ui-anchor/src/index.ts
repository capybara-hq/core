// Violation: after is not an anchor of the slot.
import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "fixture-ui-anchor",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "tasks", title: { zh: "任务", en: "Tasks" }, slot: "conversation.properties.section", after: "nowhere", kind: "view" },
  ],
  permissions: { ui: { views: ["tasks"] } },
  setup(ctx) {
    ctx.ui.view("tasks", async () => ({ blocks: [] }));
  },
});
