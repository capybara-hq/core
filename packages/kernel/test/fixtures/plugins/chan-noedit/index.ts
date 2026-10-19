import { definePlugin } from "@capybara-hq/plugin-sdk";
import { makeFakeImChannel } from "../fake-im/index.js";

/** 不能编辑已发消息的测试渠道（features.edit = false）：内核不发草稿，只在定稿时发一条。其余同 chan-mini。 */
export default definePlugin({
  name: "chan-noedit",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", makeFakeImChannel({ cards: true, edit: false, threads: true }));
  },
});
