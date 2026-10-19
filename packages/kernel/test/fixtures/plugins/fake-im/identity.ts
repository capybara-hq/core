import type { ExternalIdentity, IdentitySource } from "@capybara-hq/plugin-sdk";
import type { FakeImDeployment } from "./index.js";

interface TokenResponse {
  user: {
    externalId: string;
    tenantId: string;
    email?: string;
    emailVerified?: boolean;
    displayName: string;
  };
  nonce: string;
}

/**
 * 假 IM 平台的 `identity-source@1`（登录）：授权地址指向平台的 `/oauth/authorize`；回调用授权码在
 * `/oauth/token` 换用户资料，核对 nonce 与租户。身份源键 `fake-im:<租户>` 与渠道入站、通讯录相同，
 * 同一个人只对应一行身份。
 */
export const fakeImIdentitySource: IdentitySource = {
  label: { zh: "假 IM", en: "Fake IM" },
  authorizeUrl({ config, redirectUri, state, nonce }) {
    const c = config as FakeImDeployment;
    const u = new URL(`${c.platformUrl}/oauth/authorize`);
    u.searchParams.set("client_id", c.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("nonce", nonce);
    return u.toString();
  },
  async callback({ config, query, nonce, signal }): Promise<ExternalIdentity> {
    const c = config as FakeImDeployment;
    if (query.error !== undefined) throw new Error(`authorization failed: ${query.error}`);
    if (query.code === undefined) throw new Error("authorization code missing");
    const res = await fetch(`${c.platformUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pid": String(process.pid) },
      body: JSON.stringify({
        code: query.code,
        clientId: c.clientId,
        clientSecret: c.clientSecret,
      }),
      signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`token exchange failed with status ${res.status}`);
    }
    const t = (await res.json()) as TokenResponse;
    if (t.nonce !== nonce) throw new Error("nonce mismatch");
    if (t.user.tenantId !== c.tenant) throw new Error("user belongs to another tenant");
    return {
      source: `fake-im:${t.user.tenantId}`,
      externalId: t.user.externalId,
      tenantId: t.user.tenantId,
      ...(t.user.email !== undefined && { email: t.user.email }),
      emailVerified: t.user.emailVerified ?? false,
      displayName: t.user.displayName,
    };
  },
};
