import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 测试观察点：setup 次数。 */
export const diamondD = (): { setups: number } => {
  const g = globalThis as { __diamondD?: { setups: number } };
  g.__diamondD ??= { setups: 0 };
  return g.__diamondD;
};

/** 菱形依赖的底：optional diamond-b 与 diamond-c 各自提供的能力；提供方连锁变化时只应重新加载一次。 */
export default defineExtension({
  name: "diamond-d",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  optional: ["directory@1", "identity-source@1"],
  setup() {
    diamondD().setups += 1;
  },
});
