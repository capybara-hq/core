import {
  definePlugin,
  type ExternalIdentity,
  type IdentitySource,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** 测试用授权码：base64url(JSON)。`nonce` 必须与发起时一致；`source` 可伪造成别的插件的身份源。 */
export interface FakeIdpCode {
  sub: string;
  nonce: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  source?: string;
}

export const fakeIdpCode = (c: FakeIdpCode): string =>
  Buffer.from(JSON.stringify(c)).toString("base64url");

const Deployment = z.object({ tenant: z.string(), clientSecret: secret(z.string()) });

/** 测试用 `identity-source@1`：授权地址带上 state / nonce / 租户；回调把授权码解成外部身份。 */
export default definePlugin({
  name: "fake-idp",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["identity-source@1"],
  config: { deployment: Deployment },
  setup(ctx) {
    const src: IdentitySource = {
      label: { zh: "测试身份源", en: "Fake IdP" },
      authorizeUrl({ config, redirectUri, state, nonce }) {
        const c = config as z.infer<typeof Deployment>;
        const u = new URL("https://idp.example/authorize");
        u.searchParams.set("tenant", c.tenant);
        u.searchParams.set("redirect_uri", redirectUri);
        u.searchParams.set("state", state);
        u.searchParams.set("nonce", nonce);
        return u.toString();
      },
      async callback({ config, query, nonce }): Promise<ExternalIdentity> {
        const c = config as z.infer<typeof Deployment>;
        if (c.clientSecret !== "s3cret") throw new Error("bad client secret");
        if (query.code === undefined || query.code === "boom") throw new Error("upstream failed");
        const p = JSON.parse(Buffer.from(query.code, "base64url").toString()) as FakeIdpCode;
        if (p.nonce !== nonce) throw new Error("nonce mismatch");
        return {
          source: p.source ?? `fake-idp:${c.tenant}`,
          externalId: p.sub,
          tenantId: c.tenant,
          ...(p.email !== undefined && { email: p.email }),
          emailVerified: p.emailVerified ?? false,
          displayName: p.name ?? p.sub,
        };
      },
    };
    ctx.provide("identity-source@1", src);
  },
});
