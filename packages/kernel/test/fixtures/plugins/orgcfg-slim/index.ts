import { definePlugin, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** `orgcfg` 的精简版（同名、去掉 `webhook.token`），模拟插件升级后删除了一个 secret 字段。 */
export default definePlugin({
  name: "orgcfg",
  version: "2.0.0",
  sdk: "^0.1.0",
  provides: [],
  config: {
    org: z.object({
      appId: z.string(),
      appSecret: secret(z.string()),
      webhook: z.object({ path: z.string().default("/hook") }).prefault({}),
    }),
  },
  setup() {},
});
