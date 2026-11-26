import { defineExtension } from "@capybara-hq/plugin-sdk";
import { makeFakeImChannel } from "../../../../../testing/fixtures/extensions/fake-im/src/index.js";

/**
 * A channel with cards and edits but no `features.progress` (a released plugin without a
 * `progress` branch): the kernel sends a run's progress card as text and edits that text.
 * Otherwise the same as chan-mini.
 */
export default defineExtension({
  name: "chan-textprogress",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", makeFakeImChannel({ cards: true, edit: true, threads: true }));
  },
});
