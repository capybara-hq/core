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
      /** The account's linked external identities. */
      identities: (): readonly unknown[] => [...all, "identities"],
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
      /** The skills an agent wrote itself. */
      agentSkills: (agentId: string): readonly unknown[] => [...all, "agentSkills", agentId],
      /** The org's agent templates (from plugins). */
      agentTemplates: (): readonly unknown[] => [...all, "agentTemplates"],
      /** The org skill library. */
      skills: (): readonly unknown[] => [...all, "skills"],
      /** One org skill (its body, files and versions). */
      skill: (skillId: string): readonly unknown[] => [...all, "skill", skillId],
      /** Every skill detail read (an invalidation prefix: a linked copy's detail too). */
      skillAll: (): readonly unknown[] => [...all, "skill"],
      /** The org's channel connections. */
      channels: (): readonly unknown[] => [...all, "channels"],
      /** One channel connection. */
      channel: (channelId: string): readonly unknown[] => [...all, "channel", channelId],
      /** A channel plugin's connection schema. */
      channelSchema: (plugin: string): readonly unknown[] => [...all, "channelSchema", plugin],
      /** The org's extensions (installed plugins with an extension, enabled or not). */
      orgExtensions: (): readonly unknown[] => [...all, "orgExtensions"],
      /** The org's `org-default` extension points: candidates, stored and effective default. */
      extensionPointDefaults: (): readonly unknown[] => [...all, "extensionPointDefaults"],
      /** Whether each `org-default` point has a provider for the org now (the web tools). */
      extensionPointsAvailable: (): readonly unknown[] => [...all, "extensionPointsAvailable"],
      /** The tools of the extensions enabled in the org (the agent form's extension tools). */
      extensionTools: (): readonly unknown[] => [...all, "extensionTools"],
      /** The catalog from the org's view (the items it may install). */
      catalog: (): readonly unknown[] => [...all, "catalog"],
      /** Every catalog item read (an invalidation prefix). */
      catalogItemsAll: (): readonly unknown[] => [...all, "catalogItem"],
      /** One catalog item from the org's view (its latest version's components). */
      catalogItem: (itemId: string): readonly unknown[] => [...all, "catalogItem", itemId],
      /** The marketplace entries an org admin browses (source `""`: all; search `""`: none). */
      marketplaceEntries: (sourceId: string, q: string): readonly unknown[] => [
        ...all,
        "marketplaceEntries",
        sourceId,
        q,
      ],
      /** The plugins installed in the org. */
      pluginInstalls: (): readonly unknown[] => [...all, "pluginInstalls"],
      /** Every read of the platform components offered to the org (an invalidation prefix). */
      componentsAll: (): readonly unknown[] => [...all, "components"],
      /** The components offered to the org (`""`: every kind / every plugin). */
      components: (kind: string, itemId: string): readonly unknown[] => [
        ...all,
        "components",
        kind,
        itemId,
      ],
      /** My standing tool grants in the org. */
      toolGrants: (): readonly unknown[] => [...all, "toolGrants"],
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
      /** My inbox (its items). */
      inbox: (): readonly unknown[] => [...all, "inbox"],
      inboxCount: (): readonly unknown[] => [...all, "inboxCount"],
      /** One skill change with its files and the skill's current version (the inbox's detail). */
      skillChange: (changeId: string): readonly unknown[] => [...all, "skillChange", changeId],
      extensionPages: (): readonly unknown[] => [...all, "extensionPages"],
      /** The org's members. */
      members: (): readonly unknown[] => [...all, "members"],
      /** The org's settings (with the deployment's defaults and the sandbox limits). */
      orgSettings: (): readonly unknown[] => [...all, "orgSettings"],
      /** The org's invitations (admins). */
      invitations: (): readonly unknown[] => [...all, "invitations"],
      /** The org's model purposes and what each maps to. */
      orgPurposes: (): readonly unknown[] => [...all, "orgPurposes"],
      /** The org's file previewers (which extension previews which files). */
      orgFilePreviewers: (): readonly unknown[] => [...all, "orgFilePreviewers"],
      /** The org's service tokens. */
      serviceTokens: (): readonly unknown[] => [...all, "serviceTokens"],
      /** The org's eval sets. */
      evalSets: (): readonly unknown[] => [...all, "evalSets"],
      /** One eval set (with its cases). */
      evalSet: (setId: string): readonly unknown[] => [...all, "evalSet", setId],
      /** An eval set's runs. */
      evalRuns: (setId: string): readonly unknown[] => [...all, "evalRuns", setId],
      /** One eval case's snapshot trajectory. */
      evalCase: (setId: string, caseId: string): readonly unknown[] => [
        ...all,
        "evalCase",
        setId,
        caseId,
      ],
      /** The cost estimate of an eval run's input (`body`: the input as JSON). */
      evalEstimate: (setId: string, body: string): readonly unknown[] => [
        ...all,
        "evalEstimate",
        setId,
        body,
      ],
      /** One eval run and the result rows read so far (the polling's state). */
      evalRun: (runId: string): readonly unknown[] => [...all, "evalRun", runId],
      /** A page of an eval run's result rows after a cursor ("Load more"). */
      evalResultPage: (runId: string, after: string): readonly unknown[] => [
        ...all,
        "evalResultPage",
        runId,
        after,
      ],
      /** One eval result's full row, as of a row's `updatedAt`. */
      evalResult: (runId: string, resultId: string, updatedAt: string): readonly unknown[] => [
        ...all,
        "evalResult",
        runId,
        resultId,
        updatedAt,
      ],
      /**
       * The trajectory list under one set of filters (each set its own entry), from its first
       * page (`before: ""`) or after a cursor.
       */
      trajectories: (agentId: string, status: string, before = ""): readonly unknown[] => [
        ...all,
        "trajectories",
        agentId,
        status,
        before,
      ],
      /** A conversation's trajectory: its latest runs (`before: ""`) or the runs before a cursor. */
      trajectory: (conversationId: string, before = ""): readonly unknown[] => [
        ...all,
        "trajectory",
        conversationId,
        before,
      ],
      /** The org's models (by provider). */
      models: (): readonly unknown[] => [...all, "models"],
      /** The org's connectors. */
      connectors: (): readonly unknown[] => [...all, "connectors"],
      /** The connector kinds whose extension is enabled in the org (the install wizard). */
      connectorKinds: (): readonly unknown[] => [...all, "connectorKinds"],
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
          /** The background tasks (also the prefix of their outputs: a change reads both). */
          background: (): readonly unknown[] => [...c, "background"],
          /** One background task's output tail. */
          backgroundOutput: (taskId: string): readonly unknown[] => [
            ...c,
            "background",
            taskId,
            "output",
          ],
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
      /** Whether the deployment still needs its first admin (`GET /setup`). */
      setupStatus: (): readonly unknown[] => [...all, "setupStatus"],
      /** An invitation's public preview, by its token (no session needed). */
      invitation: (token: string): readonly unknown[] => [...all, "invitation", token],
      /**
       * An IM identity binding waiting for confirmation, by its token. The visitor must be signed in
       * to read it, but its answer is the IM identity, the same whoever asks; a sign-in or sign-out
       * drops the whole cache anyway.
       */
      pendingBinding: (token: string): readonly unknown[] => [...all, "pendingBinding", token],
      /** The admin console's four overview numbers. */
      adminOverview: (): readonly unknown[] => [...all, "adminOverview"],
      /** The super admin's inbox (its items). */
      adminInbox: (): readonly unknown[] => [...all, "adminInbox"],
      /** How many items wait in the super admin's inbox (the admin sidebar's count). */
      adminInboxCount: (): readonly unknown[] => [...all, "adminInboxCount"],
      /** Every page of the accounts list (an invalidation prefix). */
      adminAccountsAll: (): readonly unknown[] => [...all, "adminAccounts"],
      /** A page of the accounts list: the first (`after: ""`) or the one after a cursor. */
      adminAccounts: (after = ""): readonly unknown[] => [...all, "adminAccounts", after],
      /** The deployment's orgs. */
      adminOrgs: (): readonly unknown[] => [...all, "adminOrgs"],
      /** The deployment settings. */
      settings: (): readonly unknown[] => [...all, "settings"],
      /** The providers with their models and the price table. */
      adminModels: (): readonly unknown[] => [...all, "adminModels"],
      /** The purposes' deployment defaults. */
      adminPurposes: (): readonly unknown[] => [...all, "adminPurposes"],
      /** The deployment's extensions (with the drain time limit). */
      extensions: (): readonly unknown[] => [...all, "extensions"],
      /** One extension (the detail page's poll while it converges). */
      extension: (name: string): readonly unknown[] => [...all, "extension", name],
      /** Every extension's deployment config (an invalidation prefix). */
      extensionConfigsAll: (): readonly unknown[] => [...all, "extensionConfig"],
      /** One extension's deployment config. */
      extensionConfig: (name: string): readonly unknown[] => [...all, "extensionConfig", name],
      /** The catalog's items. */
      catalog: (): readonly unknown[] => [...all, "catalog"],
      /** Every catalog item read (an invalidation prefix). */
      catalogItemsAll: (): readonly unknown[] => [...all, "catalogItem"],
      /** One catalog item with its versions. */
      catalogItem: (itemId: string): readonly unknown[] => [...all, "catalogItem", itemId],
      /** A staged plugin import's review. */
      stagedImport: (stagingId: string): readonly unknown[] => [...all, "stagedImport", stagingId],
      /** The plugins waiting for a permission confirmation (待确认). */
      catalogPending: (): readonly unknown[] => [...all, "catalogPending"],
      /** The pending catalog requests at the deployment stage. */
      catalogRequests: (): readonly unknown[] => [...all, "catalogRequests"],
      /** The marketplaces (with the offline flag). */
      marketplaces: (): readonly unknown[] => [...all, "marketplaces"],
      /** Every platform component read (lists and versions; an invalidation prefix). */
      componentsAll: (): readonly unknown[] => [...all, "components"],
      /** The platform components of one kind (`skill` / `connector_template` / `agent_template`). */
      components: (kind: string): readonly unknown[] => [...all, "components", kind],
      /** One platform component's versions. */
      componentVersions: (kind: string, id: string): readonly unknown[] => [
        ...all,
        "components",
        kind,
        id,
        "versions",
      ],
      /** Every entries read (an invalidation prefix). */
      marketplaceEntriesAll: (): readonly unknown[] => [...all, "marketplaceEntries"],
      /** The marketplace entries of one source (`""`: all) and search (`""`: none). */
      marketplaceEntries: (sourceId: string, q: string): readonly unknown[] => [
        ...all,
        "marketplaceEntries",
        sourceId,
        q,
      ],
    };
  },
};
