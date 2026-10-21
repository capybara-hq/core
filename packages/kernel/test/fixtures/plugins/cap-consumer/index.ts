import { definePlugin, type PluginContext } from "@capybara-hq/plugin-sdk";

type Chan = { id: string };

/**
 * 测试用：requires channel@1、optional directory@1；在 setup 内取用被依赖方，结果经 counter@1 交给测试，
 * ctx 存到 globalThis 以便测试在 setup 之后按组织取用。
 */
export default definePlugin({
  name: "cap-consumer",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  requires: ["channel@1"],
  optional: ["directory@1"],
  setup(ctx: PluginContext) {
    (globalThis as { __capCtx?: PluginContext }).__capCtx = ctx;
    ctx.provide("counter@1", {
      channels: ctx.capabilities.list<Chan>("channel@1").map((e) => `${e.plugin}:${e.impl.id}`),
      directories: ctx.capabilities.list("directory@1").length,
      picked: ctx.capabilities.get<Chan>("channel@1", "cap-chan-b").id,
    });
  },
});
