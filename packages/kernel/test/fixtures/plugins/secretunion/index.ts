import { definePlugin, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 组织级配置把 secret 放在 discriminatedUnion 里：内核无法按对象路径拆出密钥，加载必须失败。 */
export default definePlugin({
  name: "secretunion",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  config: {
    org: z.object({
      auth: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("none") }),
        z.object({ kind: z.literal("token"), token: secret(z.string()) }),
      ]),
    }),
  },
  setup() {
    throw new Error("setup must not run");
  },
});
