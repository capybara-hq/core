import { definePlugin, type PluginContext } from "@capybara-hq/plugin-sdk";

/** Test plugin: a policy hook on tool.preExecute and an observe hook on model.response. */
export default definePlugin({
  name: "hooks-a",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: { hooks: ["tool.preExecute", "model.response"], policyHooks: ["tool.preExecute"] },
  setup(ctx: PluginContext) {
    ctx.hooks.on(
      "tool.preExecute",
      (p) => ((p.input as { deny?: boolean }).deny ? { deny: "blocked by hooks-a" } : undefined),
      { mode: "policy" },
    );
    ctx.hooks.on("model.response", () => {}, { mode: "observe" });
  },
});
