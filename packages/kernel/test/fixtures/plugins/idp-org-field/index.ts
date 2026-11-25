import { defineExtension, type IdentitySource } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * A required overridable field the platform leaves empty: the host loads the extension (orgs may
 * bring the field), but its deployment config is not complete for a deployment-level sign-in.
 */
const Config = z.object({ clientId: z.string().min(1) });

/** A loaded `identity-source@1` whose deployment config is incomplete (needs_config). */
export default defineExtension({
  name: "idp-org-field",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["identity-source@1"],
  config: { deployment: Config },
  setup(ctx) {
    const src: IdentitySource = {
      label: { zh: "缺字段身份源", en: "Incomplete IdP" },
      authorizeUrl: () => "https://idp-org-field.example/authorize",
      async callback() {
        throw new Error("not used");
      },
    };
    ctx.provide("identity-source@1", src);
  },
});
