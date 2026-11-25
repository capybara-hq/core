import { defineExtension, type IdentitySource } from "@capybara-hq/plugin-sdk";

/**
 * An `identity-source@1` that declares its tenant (a pattern and a tenant that may never be
 * trusted), for the login sources tests. It needs no config; it is never signed in with.
 */
export default defineExtension({
  name: "idp-tenant",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: ["identity-source@1"],
  setup(ctx) {
    const src: IdentitySource = {
      label: { zh: "租户身份源", en: "Tenant IdP" },
      tenant: {
        label: { zh: "工作区 ID", en: "Workspace ID" },
        pattern: "^T[A-Z0-9]+$",
        placeholder: "T0123ABCD",
        neverTrusted: ["TPUBLIC"],
      },
      authorizeUrl: () => "https://idp-tenant.example/authorize",
      async callback() {
        throw new Error("not used");
      },
    };
    ctx.provide("identity-source@1", src);
  },
});
