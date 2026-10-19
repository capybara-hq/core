import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 权限快照测试：perm-a 升级到 0.1.1，权限与 0.1.0 完全相同。 */
export default definePlugin({
  name: "perm-a",
  version: "0.1.1",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  migrations: "../perm-a/migrations",
  permissions: { network: ["a.example.com"] },
  setup(ctx) {
    ctx.provide("counter@1", { v: "0.1.1" });
  },
});
