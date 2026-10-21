import { definePlugin } from "@capybara-hq/plugin-sdk";

export default definePlugin({
  name: "perm-capability",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  requires: ["counter@1"],
  setup(ctx) {
    ctx.capabilities.get("counter@1");
    ctx.capabilities.get("channel@1"); // FLAG
    ctx.capabilities.list("directory@1"); // FLAG
  },
});
