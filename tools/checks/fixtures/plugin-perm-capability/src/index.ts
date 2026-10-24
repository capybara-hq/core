import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "perm-capability",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  requires: ["counter@1"],
  setup(ctx) {
    ctx.extensionPoints.get("counter@1");
    ctx.extensionPoints.get("channel@1"); // FLAG
    ctx.extensionPoints.list("directory@1"); // FLAG
  },
});
