import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 测试为每次运行创建的一对 deferred：setup 进入等待时 resolve `entered`，放行 `gate` 前 setup 一直挂起。 */
export interface SlowGates {
  entered: { resolve: () => void };
  gate: { promise: Promise<void> };
}

/** 测试按 key 登记 deferred 的全局表名（测试结束时自行删除对应 key）。 */
export const SLOW_GATES_KEY = "__capybaraSlowFixtureGates";

function gates(): Map<string, SlowGates> {
  const g = globalThis as { [SLOW_GATES_KEY]?: Map<string, SlowGates> };
  g[SLOW_GATES_KEY] ??= new Map();
  return g[SLOW_GATES_KEY];
}

/**
 * 慢启动插件：先定义队列 handler（建立 BullMQ 连接），再等待测试放行。
 * 部署配置 `{ key }` 指向测试在 `globalThis[SLOW_GATES_KEY]` 中登记的 deferred。
 */
export default defineExtension({
  name: "slow",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  async setup(ctx) {
    const key = (ctx.config as { key?: unknown }).key;
    const g = typeof key === "string" ? gates().get(key) : undefined;
    if (!g) throw new Error(`slow fixture: no gates registered for key ${String(key)}`);
    ctx.queue.define("noop", async () => {});
    g.entered.resolve();
    await g.gate.promise;
  },
});
