/**
 * The only place query keys are built. Every key starts with its scope (`org` + id, `account` + id,
 * or `deployment`), so an org switch or sign-out can drop a whole scope. Area builders are added
 * next to `all` as `[...all, "<area>", ...rest]`.
 *
 * One literal id is allowed: `keys.account("self")`, for `me()` and `maybeMe()`. `/me` is what
 * tells the account id, so it is read before the id is known; nothing else lives under `"self"`.
 */
export const keys = {
  account(accountId: string) {
    const all = ["account", accountId] as const;
    return {
      all: all as readonly unknown[],
      /** The signed-in account (`/me`); only under `keys.account("self")`. */
      me: (): readonly unknown[] => [...all, "me"],
      /** `/me` on a public page: `null` when signed out; only under `keys.account("self")`. */
      maybeMe: (): readonly unknown[] => [...all, "maybeMe"],
    };
  },
  org(orgId: string) {
    const all = ["org", orgId] as const;
    return {
      all: all as readonly unknown[],
      readiness: (): readonly unknown[] => [...all, "readiness"],
      /** The org's agents list. */
      agents: (): readonly unknown[] => [...all, "agents"],
      /** Every view of the sidebar's conversation groups (an invalidation prefix). */
      conversationGroupsAll: (): readonly unknown[] => [...all, "conversationGroups"],
      /** The sidebar's conversation groups of one view (`"default"`: what the layout reads). */
      conversationGroups: (view: string): readonly unknown[] => [
        ...all,
        "conversationGroups",
        view,
      ],
      /** A page of a sidebar group or of groups past the first (More / More groups). */
      conversationGroupsMore: (kind: "rows" | "groups", params: string): readonly unknown[] => [
        ...all,
        "conversationGroups",
        "more",
        kind,
        params,
      ],
      inboxCount: (): readonly unknown[] => [...all, "inboxCount"],
      extensionPages: (): readonly unknown[] => [...all, "extensionPages"],
      /** The org's members. */
      members: (): readonly unknown[] => [...all, "members"],
    };
  },
  deployment() {
    const all = ["deployment"] as const;
    return {
      all: all as readonly unknown[],
      /** The sign-in sources the login page offers. */
      authSources: (): readonly unknown[] => [...all, "authSources"],
    };
  },
};
