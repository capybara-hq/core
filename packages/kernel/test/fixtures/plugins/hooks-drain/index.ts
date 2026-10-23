import { definePlugin, type PluginContext } from "@capybara-hq/plugin-sdk";

/** Shared with the test through globalThis: which generation's hooks ran, and a gate to hold them. */
export interface HooksDrainState {
  setups: number;
  calls: string[];
  gate: Promise<void> | undefined;
}

const state = (): HooksDrainState => {
  const g = globalThis as { __hooksDrain?: HooksDrainState };
  g.__hooksDrain ??= { setups: 0, calls: [], gate: undefined };
  return g.__hooksDrain;
};

/** Test plugin: each setup is one generation; its hooks record `<kind>:<generation>`. */
export default definePlugin({
  name: "hooks-drain",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: { hooks: ["tool.preExecute"] },
  setup(ctx: PluginContext) {
    const s = state();
    s.setups += 1;
    const gen = s.setups;
    ctx.hooks.on(
      "tool.preExecute",
      async (p) => {
        s.calls.push(`policy:${gen}`);
        // `hold: <generation>` waits on the gate and ignores the signal (only revocation cuts it off)
        if ((p.input as { hold?: number }).hold === gen && s.gate) await s.gate;
        return { deny: `generation ${gen}` };
      },
      { mode: "policy" },
    );
    ctx.hooks.on(
      "tool.preExecute",
      () => {
        s.calls.push(`observe:${gen}`);
      },
      { mode: "observe" },
    );
  },
});
