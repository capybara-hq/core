// Clean: a slot with an anchor.
import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "fixture-ui-slots-clean",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "tasks", title: { zh: "任务", en: "Tasks" }, slot: "conversation.properties.section", after: "files", kind: "view" },
  ],
  permissions: { ui: { views: ["tasks"] } },
  setup(ctx) {
    ctx.ui.view("tasks", async () => ({ blocks: [] }));
  },
});
