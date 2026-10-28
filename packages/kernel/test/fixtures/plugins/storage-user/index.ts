import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 存储测试：声明 permissions.storage，把自己的 ctx.storage 作为 counter@1 的实现交给测试（借用已登记的能力名）。 */
export default defineExtension({
  name: "storage-user",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["counter@1"],
  permissions: { storage: true },
  setup(ctx) {
    ctx.provide("counter@1", ctx.storage);
  },
});
