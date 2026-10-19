/** 外部身份；登录、渠道入站、通讯录三处用同一个 (source, externalId) 键。 */
export interface ExternalIdentity {
  /**
   * `"<插件名>:<租户 id>"`，必须与 `tenantId` 一致。第三方登录时内核核对
   * `source === \`${插件名}:${tenantId}\``，不一致按身份源出错拒绝。
   */
  source: string;
  externalId: string;
  tenantId: string;
  email?: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl?: string;
}

/**
 * 第三方登录（`identity-source@1`）。state、nonce 与 PKCE 都由内核生成并保存在服务端：
 * 插件把 `codeChallenge` / `codeChallengeMethod` 放进授权地址（`code_challenge` / `code_challenge_method`），
 * 回调换 token 时带上 `codeVerifier`（`code_verifier`）。平台不支持 PKCE 时忽略这几个字段即可。
 */
export interface IdentitySource {
  label: { zh: string; en: string };
  authorizeUrl(args: {
    config: unknown;
    redirectUri: string;
    state: string;
    nonce: string;
    /** PKCE challenge（base64url(SHA-256(codeVerifier))）；内核总会提供，旧内核不提供。 */
    codeChallenge?: string;
    /** PKCE challenge 的算法；内核只用 `"S256"`。 */
    codeChallengeMethod?: "S256";
  }): string;
  callback(args: {
    config: unknown;
    redirectUri: string;
    query: Record<string, string>;
    nonce: string;
    signal: AbortSignal;
    /** 与本次发起的 `codeChallenge` 对应的 PKCE verifier；内核总会提供，旧内核不提供。 */
    codeVerifier?: string;
  }): Promise<ExternalIdentity>;
}
