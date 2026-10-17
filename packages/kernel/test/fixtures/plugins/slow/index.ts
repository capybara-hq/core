import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 测试可控的 deferred。 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** setup 进入等待时 resolve（测试据此确认启动已卡在 setup 中）。 */
export const entered = deferred();
/** 由测试放行：放行前 setup 一直挂起。 */
export const gate = deferred();

/** 慢启动插件：先定义队列 handler（建立 BullMQ 连接），再等待测试放行 `gate`。 */
export default definePlugin({
  name: "slow",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  async setup(ctx) {
    ctx.queue.define("noop", async () => {});
    entered.resolve();
    await gate.promise;
  },
});
