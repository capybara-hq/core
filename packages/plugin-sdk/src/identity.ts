/** `identity-source@1`：外部登录身份来源（用插件的部署级配置，如 client id / secret）。 */
export const IDENTITY_SOURCE_CAPABILITY = "identity-source@1" as const;

/** 外部身份；登录、渠道入站、通讯录三处用同一个 (source, externalId) 键。 */
export interface ExternalIdentity {
  /** `"<插件名>:<租户 id>"`。 */
  source: string;
  externalId: string;
  tenantId: string;
  email?: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl?: string;
}

export interface IdentitySource {
  label: { zh: string; en: string };
  authorizeUrl(args: {
    config: unknown;
    redirectUri: string;
    state: string;
    nonce: string;
  }): string;
  callback(args: {
    config: unknown;
    redirectUri: string;
    query: Record<string, string>;
    nonce: string;
    signal: AbortSignal;
  }): Promise<ExternalIdentity>;
}
