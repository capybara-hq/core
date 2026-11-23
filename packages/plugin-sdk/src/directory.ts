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
   * Optional: whether the org's effective config has the directory fully set up (e.g. every
   * required credential filled in). Implement it in an extension whose directory fields are
   * optional (the same extension also provides other extension points such as a channel, and an
   * org that uses only those leaves the directory fields empty). When it returns false the kernel
   * treats the directory as "not configured": the hourly scan, `directory_changed` and the
   * pre-removal recheck are skipped silently (no job, no audit, no warning), and a manual sync by an
   * admin returns 409 `directory.not_configured`. When not implemented, any config that satisfies
   * the schema counts as configured. Must be a pure function (no requests, never throws). `config`
   * is the effective config for the org (see `listMembers`' `config`).
   */
  configured?(config: unknown): boolean;
  listMembers(args: {
    /**
     * The extension's effective config for this org: the platform's deployment config with the
     * org's copy applied to the overridable fields (every field not marked `platformOnly`), or the
     * platform's config (equal to `ctx.config`) while the org follows it. Use it, not `ctx.config`,
     * for work done for this org.
     */
    config: unknown;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<{ members: DirectoryMember[]; next?: string }>;
}
