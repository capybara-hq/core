import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * setup 中经回调拿到的 Kysely 试图销毁内核连接池：应被 ctx.db 拦截。
 * 部署配置 `via` 选择路径：`transaction`（默认）或 `connection`。
 */
export default defineExtension({
  name: "dbdestroy-cb",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  async setup(ctx) {
    const via = (ctx.config as { via?: unknown }).via ?? "transaction";
    if (via === "connection") {
      await ctx.db.connection().execute((c) => c.destroy());
    } else {
      await ctx.db.transaction().execute((t) => t.destroy());
    }
  },
});
