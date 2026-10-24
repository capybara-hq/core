import { definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 延后加载链的中间一环：requires counter@1（只由安装记录提供）、provides counter@2；部署配置 port 必填。 */
export default definePlugin({
  name: "chain-mid",
  version: "0.1.0",
  sdk: "^0.1.0",
  requires: ["counter@1"],
  provides: ["counter@2"],
  config: { deployment: z.object({ port: z.number() }) },
  setup(ctx) {
    ctx.provide("counter@2", { mid: true });
  },
});
