import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 权限快照测试：perm-a 0.1.0（提供 counter@1，声明一个域名，带一张表）。 */
export default defineExtension({
  name: "perm-a",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["counter@1"],
  migrations: "./migrations",
  permissions: { network: ["a.example.com"] },
  setup(ctx) {
    ctx.provide("counter@1", { v: "0.1.0" });
  },
});
