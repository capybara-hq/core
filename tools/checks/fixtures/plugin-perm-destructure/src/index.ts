import { definePlugin, type PluginContext } from "@capybara-hq/plugin-sdk";

declare const key: string;

export default definePlugin({
  name: "perm-destructure",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx) {
    const { secrets } = ctx; // FLAG
    void ctx[key]; // FLAG
    // capybara:allow-dynamic-permission members are vetted elsewhere
    const { kv } = ctx;
    void [secrets, kv];
  },
});

export const second = definePlugin({
  name: "perm-destructure-param",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup({ secrets }: PluginContext) { // FLAG
    void secrets;
  },
});

export const third = definePlugin({
  name: "perm-default-param",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx: PluginContext = {} as PluginContext) {
    void ctx.secrets; // FLAG
  },
});
