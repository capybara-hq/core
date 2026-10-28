import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 菱形依赖的一边：optional counter@1（everything 提供），provides directory@1（只做依赖关系，实现是空壳）。 */
export default defineExtension({
  name: "diamond-b",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["directory@1"],
  optional: ["counter@1"],
  setup(ctx) {
    ctx.provide("directory@1", {});
  },
});
