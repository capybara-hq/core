import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 测试用：提供 channel@1（orgScoped），供 cap-consumer 取用。 */
export default definePlugin({
  name: "cap-chan-b",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", { id: "b" });
  },
});
