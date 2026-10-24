import { defineExtension, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 带组织级配置（含 secret 字段，其中一个嵌套在对象里）的插件。 */
export default defineExtension({
  name: "orgcfg",
  version: "1.2.3",
  sdk: "^0.1.0",
  provides: [],
  config: {
    org: z.object({
      appId: z.string(),
      appSecret: secret(z.string()),
      webhook: z
        .object({
          token: secret(z.string()).optional(),
          path: z.string().default("/hook"),
        })
        .prefault({}),
    }),
  },
  setup() {},
});
