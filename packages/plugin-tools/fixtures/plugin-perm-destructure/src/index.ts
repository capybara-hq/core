import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";

declare const key: string;

export default defineExtension({
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

export const second = defineExtension({
  name: "perm-destructure-param",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup({ secrets }: ExtensionContext) { // FLAG
    void secrets;
  },
});

export const third = defineExtension({
  name: "perm-default-param",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx: ExtensionContext = {} as ExtensionContext) {
    void ctx.secrets; // FLAG
  },
});
