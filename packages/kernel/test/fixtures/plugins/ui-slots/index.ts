import { defineExtension, type UiRenderArgs, type UiView } from "@capybara-hq/plugin-sdk";

const t = (zh: string, en: string) => ({ zh, en });

/** A heading naming the render args (signal left out), so a test sees what the view received. */
const named =
  (id: string) =>
  async ({ signal: _signal, ...args }: UiRenderArgs): Promise<UiView> => ({
    blocks: [{ type: "heading", text: `${id} ${JSON.stringify(args)}` }],
  });

/**
 * UI slots fixture (UI slots spec): one view in each slot without a deprecated place
 * (`agent.detail.section`, `org.settings.section`, `platform.page`) plus an `org.page` view, each
 * with an action answering a toast; embeds in `platform.page`, `org.page` and
 * `agent.detail.section`, whose data route answers the verified embed claims (401 without); a view
 * `lost` in a slot the catalog does not know and a view `old-page` at `org.page@2` (both dropped at
 * load, the extension still loads) and a tool `ping`. Route `POST /invalidate` calls
 * `ctx.ui.invalidate` with the request body (204; 400 with the error message when it throws).
 */
export default defineExtension({
  name: "ui-slots",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "notes", title: t("笔记", "Notes"), slot: "agent.detail.section", kind: "view" },
    {
      id: "org-admin",
      title: t("组织设置", "Org admin"),
      slot: "org.settings.section",
      kind: "view",
    },
    {
      id: "platform-home",
      title: t("平台首页", "Platform home"),
      slot: "platform.page",
      kind: "view",
    },
    { id: "page", title: t("页面", "Page"), slot: "org.page", kind: "view" },
    {
      id: "platform-embed",
      title: t("平台嵌入", "Platform embed"),
      slot: "platform.page",
      kind: "embed",
      path: "/ui/platform",
    },
    {
      id: "page-embed",
      title: t("页面嵌入", "Page embed"),
      slot: "org.page",
      kind: "embed",
      path: "/ui/platform",
    },
    {
      id: "notes-embed",
      title: t("笔记嵌入", "Notes embed"),
      slot: "agent.detail.section",
      kind: "embed",
      path: "/ui/platform",
    },
    { id: "lost", title: t("丢失", "Lost"), slot: "nowhere.at-all", kind: "view" },
    // a known slot at a version the catalog does not have: dropped as unsupported-version
    { id: "old-page", title: t("旧页面", "Old page"), slot: "org.page@2", kind: "view" },
  ],
  permissions: {
    http: [
      { method: "GET", path: "/ui/platform" },
      { method: "GET", path: "/ui/platform-data" },
      { method: "POST", path: "/invalidate" },
    ],
    ui: {
      views: ["notes", "org-admin", "platform-home", "page", "lost", "old-page"],
      embeds: ["platform-embed", "page-embed", "notes-embed"],
    },
    tools: ["ping"],
  },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "ping",
        description: "Answers pong.",
        inputSchema: { type: "object", properties: {} },
        defaultPolicy: "allow",
      },
      async () => ({ content: [{ type: "text", text: "pong" }] }),
    );
    for (const id of ["notes", "org-admin", "platform-home", "page", "lost", "old-page"]) {
      ctx.ui.view(id, named(id));
      ctx.ui.action(id, async () => ({ toast: t("好", "OK") }));
    }
    ctx.http.route("GET", "/ui/platform", async () => new Response("platform"));
    ctx.http.route("GET", "/ui/platform-data", async (req) => {
      const token = new URL(req.url).searchParams.get("token") ?? "";
      const claims = await ctx.ui.verifyEmbedToken(token);
      if (claims === null) return new Response(null, { status: 401 });
      return Response.json(claims);
    });
    ctx.http.route("POST", "/invalidate", async (req) => {
      try {
        await ctx.ui.invalidate(
          (await req.json()) as { orgId?: string; conversationId?: string; contribution: string },
        );
      } catch (e) {
        return new Response((e as Error).message, { status: 400 });
      }
      return new Response(null, { status: 204 });
    });
  },
});
