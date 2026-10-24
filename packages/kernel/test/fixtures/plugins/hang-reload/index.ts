import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 测试观察点：setup 次数；`hang` 为 true 时，第一次之后的 setup 永不返回。 */
export const hangReload = (): { setups: number; hang: boolean } => {
  const g = globalThis as { __hangReload?: { setups: number; hang: boolean } };
  g.__hangReload ??= { setups: 0, hang: false };
  return g.__hangReload;
};

/** 重新加载时 setup 卡住：reload 按时限失败、旧实例保留；停机不被它拖住。 */
export default defineExtension({
  name: "hang-reload",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  async setup() {
    const p = hangReload();
    p.setups += 1;
    if (p.setups > 1 && p.hang) await new Promise<void>(() => {});
  },
});
