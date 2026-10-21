import { definePlugin, type PluginContext } from "@capybara-hq/plugin-sdk";

/** 测试用：在 setup 内尝试各种注册，把抛出的错误经 counter@1 交给测试；ctx 存到 globalThis 以便测试 setup 之后再注册。 */
export default definePlugin({
  name: "tools-probe",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  // bad name / empty 在规格校验时即被拒，无需声明；late 在 setup 之后注册（被封存拒绝）
  permissions: { tools: ["echo", "second"] },
  setup(ctx: PluginContext) {
    (globalThis as { __probeCtx?: PluginContext }).__probeCtx = ctx;
    const spec = (name: string, description = "Probe tool.") => ({
      name,
      description,
      inputSchema: { type: "object" },
    });
    const handler = async () => ({ content: [{ type: "text" as const, text: "ok" }] });
    const errors: string[] = [];
    const attempt = (fn: () => void) => {
      try {
        fn();
        errors.push("");
      } catch (e) {
        errors.push((e as Error).message);
      }
    };
    attempt(() => ctx.tools.register(spec("echo"), handler));
    attempt(() => ctx.tools.register(spec("echo"), handler)); // 重复
    attempt(() => ctx.tools.register(spec("bad name"), handler)); // 非法名
    attempt(() => ctx.tools.register(spec("empty", " "), handler)); // 空描述
    attempt(() => ctx.tools.register(spec("second"), handler));
    ctx.provide("counter@1", { errors });
  },
});
