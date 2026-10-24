import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 界面权限快照测试：ui-a 再升级到 0.3.0，多了一个 embed（路由不变）——卡加载、待批准。 */
export default defineExtension({
  name: "ui-a",
  version: "0.3.0",
  sdk: "^0.1.0",
  provides: [],
  ui: [
    { id: "tasks", title: { zh: "任务", en: "Tasks" }, place: "conversation", kind: "view" },
    {
      id: "board",
      title: { zh: "看板", en: "Board" },
      place: "page",
      kind: "embed",
      path: "/ui/board",
    },
  ],
  permissions: {
    http: [{ method: "GET", path: "/ui/board" }],
    ui: { views: ["tasks"], embeds: ["board"] },
  },
  setup(ctx) {
    ctx.http.route("GET", "/ui/board", async () => new Response("board"));
    ctx.ui.view("tasks", async () => ({ blocks: [{ type: "heading", text: "Tasks" }] }));
  },
});
