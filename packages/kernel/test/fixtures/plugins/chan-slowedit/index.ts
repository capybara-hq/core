import { defineExtension } from "@capybara-hq/plugin-sdk";
import { makeFakeImChannel } from "../fake-im/index.js";

/** 平台限制编辑频率的测试渠道（features.minEditIntervalMs = 2500）：内核按它放慢草稿更新。其余同 chan-mini。 */
export default defineExtension({
  name: "chan-slowedit",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide(
      "channel@1",
      makeFakeImChannel({ cards: true, edit: true, threads: true, minEditIntervalMs: 2500 }),
    );
  },
});
