import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 权限快照测试：perm-a 升级到 0.3.0，不再声明域名（权限变少）。 */
export default defineExtension({
  name: "perm-a",
  version: "0.3.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  migrations: "../perm-a/migrations",
  setup(ctx) {
    ctx.provide("counter@1", { v: "0.3.0" });
  },
});
