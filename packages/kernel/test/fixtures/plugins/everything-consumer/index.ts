import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";

/** 测试观察点：每次 setup 的 ctx 与当时取到的 everything 提供的 counter。 */
export interface ConsumerProbe {
  setups: number;
  ctxs: ExtensionContext[];
  seen: unknown[];
}

export const consumerProbe = (): ConsumerProbe => {
  const g = globalThis as { __everythingConsumer?: ConsumerProbe };
  g.__everythingConsumer ??= { setups: 0, ctxs: [], seen: [] };
  return g.__everythingConsumer;
};

/** optional counter@1（everything 提供）：提供方实例变了，本插件在本副本重新加载。 */
export default defineExtension({
  name: "everything-consumer",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  optional: ["counter@1"],
  setup(ctx: ExtensionContext) {
    const probe = consumerProbe();
    probe.setups += 1;
    probe.ctxs.push(ctx);
    probe.seen.push(ctx.extensionPoints.list("counter@1").map((e) => e.impl));
  },
});
