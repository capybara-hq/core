import { definePlugin } from "@capybara-hq/plugin-sdk";

interface JobData {
  n?: number;
  /** handler 写入的 kv 键，默认 `done`。 */
  key?: string;
  /** handler 写 kv 前等待的毫秒数（模拟耗时任务）。 */
  delayMs?: number;
}

/**
 * 定义一个队列 handler 并在 setup 时入队一个任务；handler 执行后写 kv `<key>`（默认 `done`）。
 * 带 `delayMs` 时先写 `<key>.started`，等待后再写 `<key>`，供测试观察「执行中」的任务。
 */
export default definePlugin({
  name: "jobber",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  async setup(ctx) {
    ctx.queue.define("job", async (raw) => {
      const data = raw as JobData;
      const key = data.key ?? "done";
      if (data.delayMs !== undefined) {
        await ctx.kv.set(`${key}.started`, "1", { ttlSeconds: 60 });
        await new Promise((r) => setTimeout(r, data.delayMs));
      }
      await ctx.kv.set(key, JSON.stringify(data), { ttlSeconds: 60 });
    });
    await ctx.queue.add("job", { n: 1 }, { jobId: "only-once" });
  },
});
