import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 界面权限快照测试：ui-a 0.1.0（只有一条 GET /ui/board 路由，还没有界面贡献）。 */
export default defineExtension({
  name: "ui-a",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { http: [{ method: "GET", path: "/ui/board" }] },
  setup(ctx) {
    ctx.http.route("GET", "/ui/board", async () => new Response("board"));
  },
});
