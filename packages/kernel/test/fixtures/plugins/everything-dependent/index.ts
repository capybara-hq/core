import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";

/** 测试观察点：setup 与 dispose 次数。 */
export interface DependentProbe {
  setups: number;
  disposed: number;
}

export const dependentProbe = (): DependentProbe => {
  const g = globalThis as { __everythingDependent?: DependentProbe };
  g.__everythingDependent ??= { setups: 0, disposed: 0 };
  return g.__everythingDependent;
};

/** requires counter@1（只有 everything 提供）：提供方卸下时本插件随之卸下（dependency），回来时重新加载。 */
export default defineExtension({
  name: "everything-dependent",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  requires: ["counter@1"],
  setup(_ctx: ExtensionContext) {
    dependentProbe().setups += 1;
  },
  dispose() {
    dependentProbe().disposed += 1;
  },
});
