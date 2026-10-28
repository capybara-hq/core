import { defineExtension, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default defineExtension({
  name: "secretcfg",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  config: { deployment: z.object({ token: secret(z.string()) }) },
  setup(ctx) {
    ctx.log.info("got", { t: (ctx.config as { token: string }).token });
  },
});
