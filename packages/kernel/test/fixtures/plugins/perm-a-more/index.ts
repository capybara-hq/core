import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 权限快照测试：perm-a 升级到 0.2.0，多声明一个域名（权限变多）。 */
export default definePlugin({
  name: "perm-a",
  version: "0.2.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  migrations: "../perm-a/migrations",
  permissions: { network: ["a.example.com", "b.example.com"] },
  setup(ctx) {
    ctx.provide("counter@1", { v: "0.2.0" });
  },
});
