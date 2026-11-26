import { defineExtension, type IdentitySource, platformOnly } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** Required platform-only config the login sources tests never give: the extension waits for it. */
const Config = platformOnly(z.object({ clientSecret: z.string().min(1) }));

/** An `identity-source@1` pending configuration (enabling it is refused as needs_config). */
export default defineExtension({
  name: "idp-unconfigured",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["identity-source@1"],
  config: { deployment: Config },
  setup(ctx) {
    Config.parse(ctx.config ?? {});
    const src: IdentitySource = {
      label: { zh: "未配置身份源", en: "Unconfigured IdP" },
      authorizeUrl: () => "https://idp-unconfigured.example/authorize",
      async callback() {
        throw new Error("not used");
      },
    };
    ctx.provide("identity-source@1", src);
  },
});
