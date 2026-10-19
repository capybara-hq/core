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
