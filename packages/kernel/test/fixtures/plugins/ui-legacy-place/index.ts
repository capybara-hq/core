import { defineExtension, type UiView } from "@capybara-hq/plugin-sdk";

const title = { zh: "任务", en: "Tasks" };
const view = (text: string): UiView => ({ blocks: [{ type: "heading", text }] });

/**
 * The UI manifest shape of `todo@0.1.0-rc.2`, still on the deprecated `place` (UI slots spec,
 * step A): a panel, a properties section, an inline card and the retired `tasks` alias of the panel
 * (old place `conversation`). The tool `write` returns a card naming `tasks-card`. Installed from a
 * packed tgz in tests, so the reviewed static manifest (with `place`) is compared at load.
 */
export default defineExtension({
  name: "ui-legacy-place",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "tasks-panel", title, place: "panel", kind: "view", icon: "list-checks" },
    { id: "tasks-section", title, place: "section", kind: "view", icon: "list-checks" },
    { id: "tasks-card", title, place: "inline", kind: "view", icon: "list-checks" },
    { id: "tasks", title, place: "conversation", kind: "view", aliasOf: "tasks-panel" },
  ],
  permissions: {
    ui: { views: ["tasks-panel", "tasks-section", "tasks-card", "tasks"] },
    tools: ["write"],
  },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "write",
        description: "Replaces the task list of the conversation.",
        inputSchema: { type: "object", properties: {} },
        defaultPolicy: "allow",
      },
      async () => ({
        content: [{ type: "text", text: "written" }],
        card: { view: "tasks-card", key: "snap-1" },
      }),
    );
    ctx.ui.view("tasks-panel", async () => view("tasks-panel"));
    ctx.ui.view("tasks-section", async () => view("tasks-section"));
    ctx.ui.view("tasks-card", async () => view("tasks-card"));
  },
});
