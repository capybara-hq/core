export interface DirectoryMember {
  externalId: string;
  tenantId: string;
  email?: string;
  emailVerified: boolean;
  displayName: string;
  active: boolean;
}

export interface Directory {
  /**
   * 可选：这份组织级配置是否已把通讯录配好（如必填凭据都已填写）。组织级配置里通讯录字段可选的插件
   * （同一插件还提供渠道等别的能力，组织只用那些能力时不填通讯录配置）实现它。返回 false 时内核视为
   * 「通讯录未配置」：每小时扫描、`directory_changed` 与移除前复核都静默跳过（不投递任务、不写审计、不记警告），
   * 管理员手动同步返回 409 `directory.not_configured`。不实现则只要配置满足 schema 就算已配置。
   * 必须是纯函数（不发请求、不抛错）。
   */
  configured?(orgConfig: unknown): boolean;
  listMembers(args: {
    orgConfig: unknown;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<{ members: DirectoryMember[]; next?: string }>;
}
