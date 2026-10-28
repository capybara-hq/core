import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";

/** Test plugin: a second `usage.report` subscriber; counts deliveries per eventId in ctx.kv. */
export default defineExtension({
  name: "usage-b",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { hooks: ["usage.report"], http: [{ method: "GET", path: "/seen" }] },
  setup(ctx: ExtensionContext) {
    ctx.hooks.on(
      "usage.report",
      async (p) => {
        await ctx.kv.incr(`seen:${p.eventId}`, { ttlSeconds: 600 });
      },
      { mode: "observe" },
    );
    ctx.http.route("GET", "/seen", async (req) => {
      const id = new URL(req.url).searchParams.get("eventId") ?? "";
      return Response.json({ calls: Number((await ctx.kv.get(`seen:${id}`)) ?? 0) });
    });
  },
});
