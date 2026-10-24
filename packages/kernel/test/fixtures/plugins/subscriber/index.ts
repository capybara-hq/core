import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "subscriber",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  async setup(ctx) {
    await ctx.bus.subscribe("t", async (payload) => {
      await ctx.kv.set("got", JSON.stringify(payload), { ttlSeconds: 60 });
    });
  },
});
