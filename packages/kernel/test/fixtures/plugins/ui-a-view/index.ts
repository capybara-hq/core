import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 界面权限快照测试：ui-a 升级到 0.2.0，只多了一个 view（不卡加载，快照自动补上）。 */
export default defineExtension({
  name: "ui-a",
  version: "0.2.0",
  sdk: "^0.1.0",
  provides: [],
  ui: [{ id: "tasks", title: { zh: "任务", en: "Tasks" }, place: "conversation", kind: "view" }],
  permissions: { http: [{ method: "GET", path: "/ui/board" }], ui: { views: ["tasks"] } },
  setup(ctx) {
    ctx.http.route("GET", "/ui/board", async () => new Response("board"));
    ctx.ui.view("tasks", async () => ({ blocks: [{ type: "heading", text: "Tasks" }] }));
  },
});
