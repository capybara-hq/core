import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 定义一个队列 handler 并在 setup 时入队一个任务；handler 执行后写 kv `done`。 */
export default definePlugin({
  name: "jobber",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  async setup(ctx) {
    ctx.queue.define("job", async (data) => {
      await ctx.kv.set("done", JSON.stringify(data), { ttlSeconds: 60 });
    });
    await ctx.queue.add("job", { n: 1 }, { jobId: "only-once" });
  },
});
