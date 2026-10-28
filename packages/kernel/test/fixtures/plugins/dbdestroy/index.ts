import { defineExtension } from "@capybara-hq/plugin-sdk";

/** setup 中试图销毁内核连接池：应被 ctx.db 拦截。 */
export default defineExtension({
  name: "dbdestroy",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  async setup(ctx) {
    await ctx.db.destroy();
  },
});
