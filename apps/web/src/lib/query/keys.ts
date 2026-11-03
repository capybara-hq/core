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
      /** One agent. */
      agent: (agentId: string): readonly unknown[] => [...all, "agent", agentId],
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
      /** The org's models (by provider). */
      models: (): readonly unknown[] => [...all, "models"],
      /** The org's connectors. */
      connectors: (): readonly unknown[] => [...all, "connectors"],
      /** One connector's detail. */
      connector: (connectorId: string): readonly unknown[] => [...all, "connector", connectorId],
      /** The connectors' prompts (`/` menu) or resources (`@` menu). */
      connectorItems: (kind: "prompts" | "resources"): readonly unknown[] => [
        ...all,
        "connectorItems",
        kind,
      ],
      /** The extensions' UI contributions (enabled and loaded). */
      contributions: (): readonly unknown[] => [...all, "contributions"],
      /** The attachment limits. */
      attachmentLimits: (): readonly unknown[] => [...all, "attachmentLimits"],
      /** An agent's invocable skills, with a conversation's trial drafts when one is named. */
      invocableSkills: (agentId: string, conversationId: string | null): readonly unknown[] => [
        ...all,
        "invocableSkills",
        agentId,
        conversationId,
      ],
      /** One approval (who may decide, the scopes). */
      approval: (approvalId: string): readonly unknown[] => [...all, "approval", approvalId],
      /** One question (a sub-agent's, read by id). */
      question: (questionId: string): readonly unknown[] => [...all, "question", questionId],
      /**
       * Extension views: every view of a scope (a conversation id, `"org"` for org pages), or of
       * one contribution in it (prefixes), or one view (`rest`: locale, item, card).
       */
      uiViews: (scope: string, plugin?: string, contribution?: string): readonly unknown[] => [
        ...all,
        "uiView",
        scope,
        ...(plugin === undefined ? [] : [plugin]),
        ...(contribution === undefined ? [] : [contribution]),
      ],
      uiView: (
        scope: string,
        plugin: string,
        contribution: string,
        rest: string,
      ): readonly unknown[] => [...all, "uiView", scope, plugin, contribution, rest],
      /** One conversation's pieces (its row, events and what lives outside the log). */
      conversation(id: string) {
        const c = [...all, "conversation", id] as const;
        return {
          all: c as readonly unknown[],
          row: (): readonly unknown[] => [...c, "row"],
          events: (): readonly unknown[] => [...c, "events"],
          queue: (): readonly unknown[] => [...c, "queue"],
          files: (): readonly unknown[] => [...c, "files"],
          sandbox: (): readonly unknown[] => [...c, "sandbox"],
          subagents: (): readonly unknown[] => [...c, "subagents"],
          usage: (): readonly unknown[] => [...c, "usage"],
          /** Every tool-info read of the conversation (an invalidation prefix). */
          toolInfoAll: (): readonly unknown[] => [...c, "toolInfo"],
          /** Tool info for `toolKeys`, sorted (the same set is one key whatever the order). */
          toolInfo: (toolKeys: readonly string[]): readonly unknown[] => [
            ...c,
            "toolInfo",
            [...toolKeys].sort(),
          ],
          /** A call's archived output: its size (`"size"`) or its text (`"text"`). */
          output: (outputId: string, part: "size" | "text"): readonly unknown[] => [
            ...c,
            "output",
            outputId,
            part,
          ],
          /** A file's extension previewers. */
          filePreviewers: (fileId: string): readonly unknown[] => [...c, "filePreviewers", fileId],
          /** A file's preview body by one previewer (`builtin` or `plugin/id`) and locale. */
          filePreview: (fileId: string, previewer: string, locale: string): readonly unknown[] => [
            ...c,
            "filePreview",
            fileId,
            previewer,
            locale,
          ],
        };
      },
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
