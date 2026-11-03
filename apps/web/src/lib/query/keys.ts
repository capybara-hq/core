/**
 * The only place query keys are built. Every key starts with its scope (`org` + id, `account` + id,
 * or `deployment`), so an org switch or sign-out can drop a whole scope. Area builders are added
 * next to `all` as `[...all, "<area>", ...rest]`.
 */
export const keys = {
  account(accountId: string) {
    const all = ["account", accountId] as const;
    return { all } as { all: readonly unknown[] };
  },
  org(orgId: string) {
    const all = ["org", orgId] as const;
    return { all } as { all: readonly unknown[] };
  },
  deployment() {
    const all = ["deployment"] as const;
    return { all } as { all: readonly unknown[] };
  },
};
