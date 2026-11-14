import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * Test plugin for extension route access: a second extension with an org page embed, so a test
 * can hold an embed token issued for an extension other than `route-access`.
 */
export default defineExtension({
  name: "route-access-other",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    {
      id: "page",
      title: { zh: "页面", en: "Page" },
      slot: "org.page",
      kind: "embed",
      path: "/ui/page",
    },
  ],
  permissions: {
    http: [{ method: "GET", path: "/ui/page", access: "public" }],
    ui: { embeds: ["page"] },
  },
  setup(ctx) {
    ctx.http.route("GET", "/ui/page", async () => new Response("page"));
  },
});
