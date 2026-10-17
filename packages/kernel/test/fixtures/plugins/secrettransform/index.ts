import { definePlugin, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 部署配置把 secret 放在 transform 之后的对象里：内核无法打码，加载必须失败。 */
export default definePlugin({
  name: "secrettransform",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  config: {
    deployment: z.object({
      upstream: z
        .object({ key: secret(z.string()) })
        .optional()
        .transform((v) => v),
    }),
  },
  setup() {
    throw new Error("setup must not run");
  },
});
