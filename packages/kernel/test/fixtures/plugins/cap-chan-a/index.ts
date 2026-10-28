import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 测试用：提供 channel@1（orgScoped），供 cap-consumer 取用。 */
export default defineExtension({
  name: "cap-chan-a",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", { id: "a" });
  },
});
