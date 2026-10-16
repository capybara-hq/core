import { definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default definePlugin({
  name: "fixture",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  config: { deployment: z.object({ greeting: z.string().default("hi") }) },
  migrations: "./migrations",
  async setup(ctx) {
    await ctx.db.insertInto("items").values({ label: "seed" }).execute();
    ctx.http.route("GET", "/hello", async () => new Response("hello"));
    ctx.provide("counter@1", { kind: "fixture", config: ctx.config });
  },
});
