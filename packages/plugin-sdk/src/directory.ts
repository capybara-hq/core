/** `directory@1`：通讯录（用插件的组织级配置：映射的工作区 / 租户与读取凭据）。 */
export const DIRECTORY_CAPABILITY = "directory@1" as const;

export interface DirectoryMember {
  externalId: string;
  tenantId: string;
  email?: string;
  emailVerified: boolean;
  displayName: string;
  active: boolean;
}

export interface Directory {
  listMembers(args: {
    orgConfig: unknown;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<{ members: DirectoryMember[]; next?: string }>;
}
