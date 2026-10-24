import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 正例：计数放 ctx.kv（Redis），任一副本都读到同一个值。 */
export default defineExtension({
  name: "good-counter",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: {
    http: [
      { method: "POST", path: "/inc" },
      { method: "GET", path: "/count" },
    ],
  },
  setup(ctx) {
    ctx.http.route("POST", "/inc", async () =>
      Response.json({ count: await ctx.kv.incr("n", { ttlSeconds: 3600 }) }),
    );
    ctx.http.route("GET", "/count", async () => {
      const v = await ctx.kv.get("n");
      return Response.json({ count: v === null ? 0 : Number(v) });
    });
  },
});
