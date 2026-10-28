import { defineExtension } from "@capybara-hq/plugin-sdk";
import { makeFakeImChannel } from "../../../../../testing/fixtures/extensions/fake-im/src/index.js";

/**
 * 只会发纯文本的测试渠道（features.cards / edit / threads 都为 false，Ruling A33）：内核把卡片按
 * renderCardAsText 拼进正文、不传 message.cards，投递目标不带 threadId。其余同 chan-mini。
 */
export default defineExtension({
  name: "chan-plain",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", makeFakeImChannel({ cards: false, edit: false, threads: false }));
  },
});
