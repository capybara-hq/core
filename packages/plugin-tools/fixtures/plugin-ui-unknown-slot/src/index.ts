// Violation: the slot is not in the SDK's catalog.
import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "fixture-ui-unknown-slot",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "tasks", title: { zh: "任务", en: "Tasks" }, slot: "conversation.nope", kind: "view" },
  ],
  permissions: { ui: { views: ["tasks"] } },
  setup(ctx) {
    ctx.ui.view("tasks", async () => ({ blocks: [] }));
  },
});
