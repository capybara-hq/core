# @capybara-hq/kernel

## 0.1.0-rc.5

### Minor Changes

- 49ae0b5: Agents can select extension tools: the agent page's Tools section lists the tools of the extensions
  enabled in the org (new `GET /api/v1/orgs/:orgId/tools/extensions`) and adds or removes their
  references; a selected tool that is unavailable stays listed as unavailable with the reason.
- d423777: Agent templates (plugin component management phase 4): any member creates a private agent from a
  usable template (`POST /api/v1/orgs/:orgId/agents/from-template`, with `…/preview` and a `previewHash`
  that goes stale with 409 `agent.template_preview_stale`; an org admin may choose another visibility).
  The agent records its provenance (migration 0085: `created_from_template_id`, `_version`, `_name`) and
  carries the connectors the org lacks as model-invisible `pendingConnectors`, bound with
  `POST …/agents/:agentId/pending-connectors/:key/bind` or, for a member, requested through one
  `connector_setup` inbox request per agent that the org admins configure or reject. Org admins save an
  agent as an org template (`POST …/agents/:agentId/save-as-template`: platform connectors become
  `{ template }` entries, others a "needs a connector" entry with no credentials) and edit, delete and
  share org templates. Connector views name their platform connector template (`platformTemplateId`).
- 0f383d7: `GET /api/v1/orgs/:orgId/conversations/:id/agent-tree` returns a root conversation's agent tree (each
  node's status, model, time, tokens, tool calls and children; owner only), and `subagent_progress` now
  reaches the stream of every ancestor of the progressing sub-agent.
- 8f7a0a5: Background sub-agents (agent map spec `docs/superpowers/specs/2026-11-06-agent-map-design.md`).
  `Agent` dispatches sub-agents in the background: its result is immediate (the agentId), the parent
  run goes on or ends while the child works, and a child's finish reaches its parent as a
  `subagent_delivery` event (the final reply when it handed back nothing). `resume` is removed from
  the `Agent` input. A run that ends no longer stops its background children; only a forked skill's
  sub-agent still runs in the foreground. The wait sweep writes a finish delivery its finisher never
  wrote.
  
  New builtin tools: `SendMessage` (`{ to, message }`) sends to one of the caller's own sub-agents
  by agentId (absorbed by a running one at its next step; an idle one starts again with its context,
  counted as a dispatch and run as the sender's trigger account) or, from a sub-agent, to `"parent"`
  (a `note` delivery); `SubagentHandback` (`{ message }`, sub-agents only) delivers a report and the
  sub-agent keeps its turn. Sub-agents may dispatch their own sub-agents down to `subagents.maxDepth`
  levels below the root, each with its frozen `subagents` block. `subagent_delivery` is absorbable
  like a message (`user_message.dispatch.kind` tells a parent's message from the task); full-run
  replays feed recorded deliveries at their step, seed a sub-agent wake run from
  `run_started.triggerSeq` and never dispatch, send or hand back, and logs written before this change
  still rebuild with zero drift. The Claude Code tool map names `SendMessage` as a same-name tool.
  
  Upgrade note: do not mix replicas across this change. A worker without it stops a finished run's
  children (all of them are background children now) and reports a child's finish without the
  delivery; stop every old worker before new ones take sub-agent jobs. A parent run left in a
  (non-fork) `subagents` wait by the old version is resumed by the wait sweep (`sweepStuckRuns`,
  after its grace period); a child still running then delivers its finish in the background, and one
  that already finished under the old version gives its report as that `Agent` call's result, since
  the old finisher wrote no delivery for it.
- 90c6125: Bootstrap plugins: `openai-compatible` and `object-store-s3` move to 0.1.0-rc.1, and the manifest preinstalls `anthropic`, `openai`, `connector-mcp`, `connector-openapi`, `jina`, `sandbox-docker` and `todo` as optional entries (installed and enabled on the deployment, off in each organization until an org admin switches them on). `marketplace.commit` and the compose sandbox build contexts move to the plugins commit that lists them.
- 16225b1: `GET /api/v1/orgs/:orgId/connectors/kinds` lists the connector kinds whose extension is enabled in the org, with the plugin providing each. The connector install wizard offers only those kinds, and with none it points to Plugins instead of failing at the end.
- 789068d: Environments (phase 1, spec 2026-11-07-environments-design): conversations run their sandbox tools
  in a person's environment instead of a sandbox of their own. Each member gets a default personal
  environment per org (created on first need) and can create more, at most `environments.maxPersonal`
  (new config, default 10, hot). A conversation is bound to one environment when it is created
  (`environmentId` on `POST /api/v1/orgs/:orgId/conversations`, else the owner's default) and keeps
  it; its sub-agents share it, and access is checked on every sandbox tool call. New API
  `/api/v1/orgs/:orgId/environments`: list, create, get, rename, delete (the instance and files are
  destroyed by a job) and `POST /:id/files/reset` (a `sandbox-reset-files` job empties lost files,
  202). In IM, `/env` in a direct message lists the person's environments and `/env <name>` picks the
  one the next new conversation uses. Instances are suspended and destroyed when idle; files stay
  until the environment is deleted. Attachments go to `/workspace/attachments/<conversation>/` and
  skill files to `/skills/<name>@<digest>/`. The kernel drives `sandbox@2` providers only (separate
  file systems and instances; a `sandbox@1` plugin is refused). `sandbox.image` has no default any
  more: unset, each provider uses the image published with its own version. The worker job
  `environments-legacy-cleanup` destroys the per-conversation sandboxes of earlier versions (the
  legacy `sandboxes` rows; rows of a provider that is not loaded are kept). The web app has an
  environments page and an environment picker before the model in the composer.
- 7c8d05e: Extension points list the majors the kernel accepts (`EXTENSION_POINTS[name].majors`). The kernel
  refuses a plugin that provides an unsupported major (such as `sandbox@1`) with
  `extension.unsupported_extension_point` and asks it to upgrade.
- 2a12327: Marketplace entries accept `deprecated: true | { reason? }` (SDK `MarketplaceEntry.deprecated`,
  normalized by `marketplaceEntryDeprecation`; JSON Schema regenerated). A maintainer sets it by hand
  on a published version's entry; `capybara-plugin marketplace --write` keeps it, and the `--base`
  integrity rules ignore it. The kernel returns `deprecated` on marketplace entries, never reports a
  deprecated version as newer or as an item's latest marketplace version, picks the newest stable
  non-deprecated compatible version when an import names none, and refuses importing or requesting a
  deprecated version with 409 `marketplace.entry_deprecated`. The market lists show the newest stable
  version on each row (prereleases fold into 其他版本 unless no stable version can be imported) and
  list deprecated versions under 其他版本 as 已废弃, with the reason, not importable.
- 12fd552: Marketplaces list one entry per plugin. `plugin.json` `description` accepts `{ en, zh? }` as well as a string (English; read it with the SDK's `pluginDescription`), and marketplace entries accept an optional `displayName: { zh, en }`. `capybara-plugin marketplace --write` keeps one entry per public plugin at its current version, with `summary` from the localized description and `displayName` from `plugin.json`, replacing a plugin's entry when its version moves; `--check --base` replaces `marketplace-append-only` with `marketplace-version-decrease` (an entry's version only increases) and `marketplace-integrity` (a published version keeps its integrity). `capybara-plugin check` warns, without failing, when a public plugin's description has no `zh` (`release-description-zh`; findings may now be warnings). The kernel returns an entry's `displayName` (null without one) and searches it, and a single-plugin git marketplace takes the summary and display name from `plugin.json`; a catalog item keeps the English description. The market lists show the display name, else the name. model-fake gets a Chinese description.
  
  `--write` also refreshes a listed entry's `summary` and `displayName` from `plugin.json` (`marketplace-display-stale` in `--check`), and `marketplace-version-decrease` also fires when a plugin moves back to an older version a base in the older form lists. Catalog item views (admin and org) and the import review carry `descriptionZh` (the latest version's Chinese description, or null), and the plugin pages show the description in the UI language.
  
  Release order: release core and upgrade the deployed kernels before `capybara-hq/plugins` publishes
  plugins whose `description` is an object (older kernels reject it) and before the official
  marketplace drops older versions.
- 9f554a3: Org members can read the org's 扩展 page: `GET /api/v1/orgs/:orgId/extensions` is the new action
  `org.extensions.read` (member and up); a member gets each extension's state without its config, the
  secrets' state, the config schema or the permission list, admins keep the full view. The page
  hides every switch and config control for members.
- 99a00cd: Platform and org layering: org admins can switch off `all` plugins and components, deployment config
  fields carry org levels with per-org copies and an effective config delivered to every org-bound
  extension call, and org admins can turn off single extension tools.
- 5ac4bba: Org admins upload plugins and share what their org owns (plugin scope phase 3, migration 0084).
  
  - An org admin uploads a plugin `.tgz` from the workspace 插件 page (`POST
    /api/v1/orgs/:orgId/catalog/uploads/file`, then review and confirm). A package without an
    extension installs at once, owned by the org; one with an extension waits until the super admin
    confirms that exact package in 待确认 (or rejects it), and so does every later version that carries
    an extension. Plugin and extension names stay deployment-global (`plugin.name_taken` names the
    owner); names of bootstrap and marketplace plugins are reserved for org uploads
    (`plugin.name_reserved`).
  - Catalog items and platform components have an owner (平台 or an org). The owner org marks its own
    plugins and skills 可共享; only shareable items can be shown to or associated with other orgs
    (`catalog.not_shareable`), and turning it off keeps the orgs that use it. Shared items follow the
    owner's versions, with inbox notices for the orgs using them.
  - An owner deleting an item other orgs use, or an org being deleted, transfers it to the platform
    with a notice in the platform inbox; org skills become platform rows when first shared, keeping
    their ids, so agents and logs are unchanged (agent templates are not shareable until org-created
    templates exist).
  - 新建技能: `POST /api/v1/orgs/:orgId/skills` also takes `{ name, description, body }`, and the
    workspace 技能 page creates a skill from text.
  - The admin console shows owners, the share gate, org uploads in 待确认 and the new inbox kinds.
- 2fb7d41: The SDK ships agent docs (`agent-docs/`: platform concepts, plugin format, skills, agent and
  connector templates, tool naming, writing an extension, one topic per extension point), served by
  the kernel's `AgentDocs`. `ExtensionPointInfo` gains `description`, and `package.json` is an
  exported subpath. `check:agent-docs` keeps the generated field tables in step with the schemas.
- 2321382: A platform inbox for the super admin: `GET /api/v1/admin/inbox` (with `total`, and `GET /api/v1/admin/inbox/count` for the sidebar) lists the orgs' requests to the platform (`access` / `import`), plugins whose extension permissions wait for a confirmation, open plugin scope sync failures, including dependencies a platform update added that could not be installed (recorded per item and org in the new table `plugin_scope_sync_failures`, migration 0083, until a later sync of the pair does not fail) and the latest platform components migration run when it failed plugins or is stuck. The admin console gets a 收件箱 page (`/admin/inbox`) and a sidebar item with its count; each item links to the page where it is acted on.
- 3c45446: Agents gain the `Platform` builtin tool, on for new agents: an agent browses, searches and describes
  the platform's operations, calls them as the person who started the run, and reads the agent docs.
  Operations cover skills, agents, agent templates, plugins, marketplaces, requests, connectors and
  extensions (`skills.*`, `agents.*`, `plugins.*`, ...); results never carry secrets, and a super admin
  sees other orgs as counts only. Reads run; writes ask the person to confirm, and org and platform
  writes are confirmed every time and never remembered (`approval.scope_not_allowed` for any other
  scope). Tool policies can be keyed per call (`Platform:<operation>`); an approval stores its
  kernel-rendered summary (zh and en) and runs only with the exact input it showed. Confirmations show
  the operation and the summary on the web and in IM cards, and offer only the scopes the approval
  allows. Orgs gain the `platformTool` setting (`on` / `read-only` / `off`, default on) on the
  organization settings page; writes are unavailable when no person is present. Audit events of writes
  made through the tool carry `{ via: "agent", conversationId, runId, operation }`. `describe` lists an
  operation's notable errors and paged lists take `params.cursor`. `check:platform-ops` fails a kernel
  HTTP route that has neither an operation nor a reasoned exclusion.
- a965a1a: Plugin scope: enterprise plugins have a scope (all, optional, named orgs), built-in and disabled states, and the org switch, requests (access, import, enable) and a scope sync worker replace the catalog policy, grants and the install-deployment step. Importing a plugin installs its extension; the admin plugin and extension pages and the workspace plugin and extension pages move accordingly.
- 7278dec: Plugin scope phase 2: a plugin's skills, agent templates and connector templates are platform
  components, stored once for the deployment (migration 0081: `platform_skills`,
  `platform_agent_templates`, `platform_connector_templates` and their versions, files under
  `deployment/platform/`) and resolved at read time in each org where they are on; an org install no
  longer copies skills or agent templates. A component follows its plugin's scope or has its own
  (`/api/v1/admin/components/*`, preview then confirm), org admins switch single components off or on
  (`PUT /api/v1/orgs/:orgId/components/:kind/:id/switch`), and a super admin uploads a new component
  version on its own. The worker job `platform-components-migrate` (migration 0082) links org copies
  made by earlier installs to their platform components under their own ids (agent definitions and
  conversation logs are not rewritten; a copy changed in the org is pinned to its version) and renames,
  in its first run only, an org's own skill whose name a platform skill on in the org has, with an inbox
  notice. The per-org plugin upgrade routes are removed: the super admin updates a platform plugin once
  (`POST /api/v1/admin/catalog/items/:id/update/preview`, `PUT …/update` with `diffHash`), which moves
  its extension, components and every org install; connectors follow their template through
  `platform_template_id`, and an org creates connectors for added templates with
  `POST /api/v1/orgs/:orgId/catalog/:itemId/connectors`. The admin console gets 技能, 连接器模板 and
  智能体模板 pages with scope dialogs and version history, and the plugin detail's platform update
  preview.
  An org install or switch takes no `version` any more (400): an org installs the platform version, and
  dependencies resolve to their platform version (refused when it does not satisfy the range). A
  version-pinned org copy follows its platform component's availability (disable, switch-off, scope
  removal, uninstall) and counts in the previews' affected agents. The marketplace import default and
  the market row's version use one order.
- 77de995: A sub-agent's approval, question or connect card, at any depth, is shown in the root conversation
  of its tree: `subagent_waiting` is appended to the root's log (no longer to the direct parent's)
  and gains `path`, the child conversation ids from the root's child down to the waiting agent. The
  approval still goes to the trigger account inherited down the chain. "Approve for this
  conversation" grants of sub-agents are stored on and read from the root conversation, so every
  agent of the tree uses them, and the inbox links a sub-agent's approval to
  `/chat/<root>?subagent=<id>`.
- 11f56fa: Sub-agent depth, tree budget and per-conversation concurrency (agent map spec §6). New config
  `subagents.maxDepth` (1–5, default 3, hot) with an org override `maxDepth` in
  `subagentLimitOverrides`; `subagents.maxConcurrentPerRun` is renamed
  `subagents.maxConcurrentPerConversation` (config, env var and override key) and counts the active
  children of the parent conversation across its runs. Set `CAPYBARA_SUBAGENTS__MAX_CONCURRENT_PER_CONVERSATION`
  in place of `CAPYBARA_SUBAGENTS__MAX_CONCURRENT_PER_RUN`: the old env var and file key are ignored
  (the default 4 applies). Stored org overrides are migrated to the new key. Dispatch and token caps count the whole tree on
  its budget run (`runs.budget_run_id`, null for a person-triggered run). Migration 0074 adds
  `conversations.subagent_depth`, `runs.budget_run_id`, `subagent_dispatches.budget_run_id` and
  `subagent_dispatches.for_skill`.
- 927fad3: Stopping a sub-agent (`POST …/conversations/:id/abort` on its conversation) stops it and every
  sub-agent below it; the root conversation's stop still stops only its own run. Deleting a root
  conversation stops its whole sub-agent tree, and the wait sweep stops what a crash left running in
  a deleted tree. A conversation's background task list and stop routes include the tasks of every
  sub-agent below it, grandchildren too.
- 7a1e1ae: A sub-agent's delivery wakes its idle parent under the background task rules (the 60 s window,
  the paused queue, the trigger account's access), and a sub-agent is woken by its own background
  tasks and by deliveries from its own sub-agents; for a sub-agent the queue and the access checks
  are read on the root conversation. A wake run runs as the trigger account of the child run that
  delivered (or the task's), records `run_started.trigger: "subagent"` for a delivery and counts
  against the tree's budget window. A finished background sub-agent no longer stops its running
  background tasks. `runtime.wakeOnBackgroundTask` covers both kinds of wake.
  Every run of a sub-agent that ends, a wake run included, delivers its finish to the parent; a
  stopped sub-agent's finish never wakes anyone, a stopped sub-agent's background tasks all stop
  (`stoppedBy: "subagent_end"`), and resuming a root's queue releases the wakes it held for its tree.
- 0e38b13: The deployment-level role "enterprise admin" is now "super admin" (breaking, no compatibility
  aliases). Migration `0080_rename_enterprise_admin.sql` renames `accounts.is_enterprise_admin` to
  `is_super_admin` and the stored deployment setting `orgCreation: "enterprise_admin"` to
  `"super_admin"`; historical audit rows are not rewritten. API: the account field
  `isEnterpriseAdmin` is `isSuperAdmin` (`GET /api/v1/me`, the admin account list and
  `PATCH /api/v1/admin/accounts/:id`), account creation takes `superAdmin`, `orgCreation` accepts
  `"anyone" | "super_admin"`, and the error code `account.last_enterprise_admin` is
  `account.last_super_admin`. Kernel exports: the `SuperAdmin` route decorator, `SuperAdminLock` /
  `SuperAdminLockModule`, `AccountsService.countSuperAdmins` / `createSuperAdmin` /
  `createSuperAdminIfNone` / `setSuperAdminByLogin`, `authorizeSuperAdmin`.
  
  Deploying: migration 0080 renames a column, so replace all replicas at once; a rolling upgrade
  across this version breaks the replicas still running the old code.
- 26e8757: Workspace platform components: the 技能 page lists the org's own skills and the platform skills offered to the org with their state and the org admin's switch (已启用 · 平台统一 for `all`), a new 智能体模板 page lists agent templates the same way, the plugin detail lists its components with per-component switches, and an installed plugin missing a connector offers 补充配置. The kernel adds `GET /orgs/:orgId/components`, serves a linked skill copy's detail as its platform skill, and names the missing connector templates in the org catalog detail. The agent editor treats linked copy ids as their platform skill or template; the inbox shows decided requests.

### Patch Changes

- f222ff8: Agent templates describe a whole agent: `selectedSkills`, `connectors` (a connector template of the
  plugin, or a described need), `subagents` (general, template types, inline types), `modelRef`,
  `quickActions` and `instructionFiles`, all optional with limits; existing files parse unchanged.
  A connector entry may carry `policies` (tool name to `ask` / `deny`); an inline sub-agent's
  `tools` is optional (absent = all of the agent's tools, `[]` = none).
  A sub-agent dispatch resolves a template's `selectedSkills` names without pinning them.
- 3a4b54b: The agent page's Tools section puts each tool's policy on its row (a new `ToolPolicyList`): the
  built-in tools stay in the card, and each extension or connector is one row with a summary that
  opens a Sheet with its tools, select-all and a filter. A connector can now be taken tool by tool.
  The connector detail's tools carry their display `title`.
- da49ebd: The catalog's pending check reads only the packages of the items it shows: a bootstrap confirm no
  longer reads every installed extension package before the object store is loaded and no longer
  logs a warning with a stack for each one it cannot read yet.
- 3c0ad62: A conversation's history loads from the end: the page paints the log's last page and reads earlier
  pages as the reader scrolls up, without moving what is on screen. `GET …/conversations/:id/events`
  takes `before=<seq>` or `before=end` for a turn-aligned page (it starts after a run's end) with
  `turnsBefore`, the runs started before it. Sub-agents, usage and background tasks are read from
  the server when the loaded part may hide them.
- abc772e: Switching on an extension whose org config has a required field that was never saved is refused
  with the plain 400 `extension.config_invalid` and its field issues before the plugin installs
  (no 502 `plugin.install_failed`); a `config` sent in the same PUT goes into the install. On the
  扩展 page the switch of such an extension waits for the config (先填写组织级配置再启用), the
  config form offers 保存并启用 (config and switch in one PUT), and a refused config marks the
  form's fields.
- 8ee4c6c: A streaming reply is a live draft kept in Redis (coalesced to 200 ms, 10 minute TTL) and sent on the conversation stream as `event: draft` after the catch-up, so another replica or a reload sees the current text. `GET /api/v1/orgs/:orgId/conversations/:id/runs/:runId/draft` returns the drafts of a run (`[]` on a Redis error). Drafts are never written to the event log and never replayed.
- 3adad42: `GET /api/v1/orgs/:orgId/extensions` gives every extension's `provides` (the extension point names
  only), also to members, whose projection still leaves out config, secrets, the config schema and
  the permission list: the 扩展 page sorts members' lists by capability too.
- 8fd18a1: An extension tool is unavailable in an org whose effective config of the extension is not valid
  (reason `Plugin <name> needs configuration in this organization`), so the model never gets it.
- 9e90494: Bootstrap plugin `openai-compatible` moves to 0.1.0-rc.2: the DeepSeek dialect sends
  mid-conversation system notices (sub-agent reports, background notices, tool-change reminders) as
  in-place `[system]` user turns, so DeepSeek no longer moves them ahead of the conversation.
- e40774d: Every org-bound extension call (web search / fetch, directory sync, extension tools, UI views and actions, file previews, hooks including `usage.report`) carries the extension's effective config for the org; an org whose effective config is not valid gets no call (excluded from point resolution and directory sync, tool not dispatched, UI 409 `extension.needs_config`, previewers left out, policy hooks deny and observe hooks are skipped). The CLI context now provides `CacheService`, which `capybara extensions` commands need.
- e0a0d60: Deployment config fields carry org levels (hidden, read-only, overridable). The platform may leave
  required overridable fields empty: the extension still loads, its admin config view lists them in
  `orgMustConfigure` and tags each field with `org`.
- ffc33a2: Orgs may keep their own copy of an extension's overridable deployment config
  (`/api/v1/orgs/:orgId/extensions/:extension/overrides`: view, save, take, reset); platform secrets
  never enter a copy. The org extension list reports `overrideState` and `needsConfig`, and the admin
  lists the org copies of an extension (`/api/v1/admin/extensions/:name/org-overrides`).
- 45d7275: Org admins turn off single extension tools (`GET` / `PUT /api/v1/orgs/:orgId/extensions/:extension/tools[/:tool]`):
  switching off is previewed with the org's agents that selected the tool and confirmed with its
  hash; a turned-off tool is unavailable to every agent of the org, refused if called, and marked
  `switchedOff` in the agent editor's tool list. Audit `extension.tool_switched`.
- cc21d5c: Plugin and component management acceptance fixes.
  
  - The org's offered components (`GET /api/v1/orgs/:orgId/components`) and a platform skill in the
    org's skill library and detail carry their `owner` (the platform, or the org that owns it). The
    workspace pages name the owner from it everywhere: 本组织 for the org's own upload, the owner
    org's name for another org's shared item, 平台 only for the platform's.
  - Row and page head actions show their pending state until the call settles; menus never draw an
    empty group or a stray separator.
  - Plugin notices (`upload_confirmed`, `upload_rejected`, `item_shared`,
    `shared_item_updated`) carry the plugin's `displayName`; the
    inboxes lead each row with the item's display name, keep its version whole beside it
    (`v0.1.0`) and give the list column more room.
  - Plugin and component details are one centred column (facts as a KeyValue, actions and 删除 in
    the head, the license folded at the end); review and detail sections have real headings.
  - The `/` skill menu on an agent with no invocable skills explains why and links editors to the
    agent's skills.
- bdf5eba: `POST /api/v1/orgs/:orgId/conversations/:id/queue` is deprecated and now behaves as `POST …/messages`: the message is logged at once (an interjection while a run is active, a new run otherwise) and the route answers `202 { event }` instead of `201 { item }`. Nothing new is queued; items already queued by an earlier version are still sent by the dispatcher after each run and can still be listed, edited, deleted, sent now or resumed. The queue routes and the `conversation_queue` table are removed in a later release.
- 703c779: Generated conversation titles are shorter: the title prompt asks for a short noun-phrase topic of
  what the user asked (not the reply), and a generated title is capped at 48 display width (CJK counts
  2), cut on a character boundary. Renames keep their 120-character limit.
- cfee6f0: The model is told when its tool set changes mid-conversation: a step whose resolved tools differ
  from the previous request's logs a `tools_changed` event (added and removed tool names) before its
  request, rendered as a system message ("Your tools changed. Now available: … No longer available:
  …"). Step replay rebuilds it from the log with zero drift; the web timeline ignores it.
- Updated dependencies [f222ff8]
- Updated dependencies [7c8d05e]
- Updated dependencies [2a12327]
- Updated dependencies [12fd552]
- Updated dependencies [fddab56]
- Updated dependencies [99a00cd]
- Updated dependencies [2fb7d41]
- Updated dependencies [6b4da7f]
  - @capybara-hq/plugin-sdk@0.1.0-rc.3

## 0.1.0-rc.4

### Minor Changes

- 9d134ee: Agents have a profile (avatar, description, quick actions) stored outside the agent versions:
  `profile` on the agent view, `PATCH /api/v1/orgs/:orgId/agents/:agentId/profile` with
  `expectedUpdatedAt` (409 `agent.profile_conflict`), and a random preset avatar on create.
  Avatars are a preset or an uploaded png, jpg or webp (`POST …/agents/:agentId/avatar/uploads`, at
  most 2 MB), served by `GET …/agents/:agentId/avatar`.
- 0344386: Agent definitions take the system prompt as named `.md` files (`instructionFiles`, 1–20 unique
  names, at most 100 000 characters joined). The kernel joins them into `instructions`, which stays
  the model-visible field (400 `agent.instructions_mismatch` when both are given and differ); a
  definition without files reads as one `AGENTS.md`, and a new agent with no prompt gets a starter. `PATCH /agents/:id` with a definition but no `instructions` (and no
  `instructionFiles`) now keeps the current prompt instead of clearing it.
- 1e092a6: Background Bash. `Bash` takes `run_in_background`: the call reserves a task in the new
  `capybara.background_tasks` table (at most `sandbox.background.maxTasks` per sandbox), starts the
  command with `bash` in a session of its own in the sandbox (`setsid` plus its own
  `timeout -s KILL`, output in `/workspace/.capybara/tasks/<id>.out`) and returns at once. The
  builtins `TaskOutput` (a task's status and its new output, optionally waiting for it to end) and
  `TaskStop` (SIGTERM, then SIGKILL after 5 s) come with `Bash` and read or stop those tasks; the
  Claude Code tool map names them as themselves. The worker's `background-task-poll` finds finished
  and lost tasks (`sandbox.background.pollSeconds`), a daily prune drops finished rows, a sub-agent's
  tasks stop when it ends, and tasks marked lost while their process may live on are killed after the
  sandbox resumes.
  A finished task reaches the model: its `background_task_finished` event is absorbed like an
  interjection and rendered as a system message (one short line when a tool call already reported
  it), and it wakes an idle conversation: a run attributed to the task's trigger account, at most one
  wake per conversation every 60 s (`bg-wake` delayed job), never for a sub-agent's task, a person's
  stop, a paused queue, an account that can no longer send, or with `runtime.wakeOnBackgroundTask`
  (or the org setting `wakeOnBackgroundTask`) off. `run_started` records
  `trigger: "background_task"` and `triggerSeq` for such a run; full-run replays feed recorded
  finishes and seed a wake run from its finish. New routes list a conversation's tasks (with its
  sub-agents'), stop one (audited `background_task.stopped`) and read the end of its output; the SSE
  stream gains `changed: "background"`.
  
  The conversation page shows background Bash tasks: the properties panel's background section lists
  running tasks next to the sub-agents (a sub-agent's own tasks nested under it) with stop, a task
  opens its output in the right panel (`#bg-<taskId>`, read again every 2 s while it runs), a
  background `Bash` row reads "In background" and links its task, `TaskOutput` / `TaskStop` rows name
  the task, and a finished task is a one-line notice in the thread. Design: task rows in
  `BackgroundTasks`, `TaskOutputPanel`, the `notice` divider and the tool row's link slot.
- 3455513: Kernel: an org chooses the default provider of an `org-default` extension point (`web-search`,
  `web-fetch`): table `org_extension_point_defaults` (migration 0073), `ExtensionPointDefaults`
  (`resolve`, `list`, `setDefault`) and the routes `GET /api/v1/orgs/:orgId/extension-points`,
  `PUT …/extension-points/:point/default` and `GET …/extension-points/available`. Testing: the fake
  extensions `fake-web` and `fake-web-2` (scripted `web-search@1` / `web-fetch@1` providers).
  
  Kernel: the `web.*` config section (`web.search.maxResults`, `web.fetch.maxPageChars`,
  `web.fetch.maxAnswerTokens`, `web.fetch.cacheSeconds`, `web.fetch.timeoutMs`, all hot), `BuiltinTool.unavailable` may be
  async and receives `{ orgId }`, and builtin tools get `parentRunId` in their call context.
  
  Kernel: `WebSearch` and `WebFetch` are builtin tool names (`BUILTIN`, `WEB_TOOL_NAMES`) with the
  display kinds `search` / `read`; the Claude Code tool-name map lists both as same-name tools
  (new snapshots only) and Claude agent import maps `WebFetch` / `WebSearch` to them.
  
  Kernel: the builtin `WebSearch` tool (default `ask`, read-only, open-world): searches with the
  org's default `web-search@1` provider, filters the results again (absolute http(s) URLs, titled,
  unique, within `allowed_domains` / `blocked_domains` (IDN entries matched in punycode), at most
  `web.search.maxResults`) and heads
  every result with `Search date: YYYY-MM-DD (UTC).`; provider errors map to fixed texts. Calls to
  `web-search@1` and `web-fetch@1` providers are counted in flight and drained on disable / upgrade.
  
  Kernel: the builtin `WebFetch` tool (default `ask`, read-only, open-world): checks the URL
  (absolute https after upgrading `http`, no credentials, at most 2000 characters after
  normalization, a public host, also for the provider's final URL), fetches the page with the org's default `web-fetch@1`
  provider through a Redis page cache (`cache:web_page:<orgId>:<provider>:<sha256(url)>`, TTL
  `web.fetch.cacheSeconds`), returns the new URL for a redirect to another host (apex ↔ www is the
  same host), cuts pages to `web.fetch.maxPageChars` with a `[truncated]` marker, and runs under its
  own time limit `web.fetch.timeoutMs` (default 180 s) instead of `tools.timeoutMs`.
  
  Kernel: `WebFetch` answers the prompt from the page with one call on the new kernel model purpose
  `web_fetch` (label "Web page extraction"; unmapped, the calling conversation's model, a
  sub-agent's for a sub-agent's call): a fixed system prompt (`WEB_FETCH_SYSTEM_PROMPT`, plus the
  call's random page tag the page sits between, `webFetchSystemPrompt`), no tools, output capped at
  `web.fetch.maxAnswerTokens`; the page is cut with `[truncated]` to fit the target model's context
  window, read with the new `ModelPurposesService.chatLimits`. The result is the answer headed by the URL, never the
  page; a failure is a tool error and a `model.request` policy denial is the tool error "An org
  policy blocked reading this page; continue without it or ask the user." with its `hook.denied`
  audit row and `hook_denied` event. The call fires `model.request` / `model.response` with
  `purpose: "web_fetch"` and logs a `usage` event with `purpose: "web_fetch"` and the call's
  `callId` (reported through `usage.report`, counted on a sub-agent's parent run). `StepLog` has a
  module of its own (`StepLogModule`) and builtin tools get the run's hook scope in their call
  context.

### Patch Changes

- ce0e90c: Personal settings moved to `/account/*`: the OAuth default return path and the connect link in
  channel cards now point at `/account/connections`.
- 9e9ce5b: Config forms review fixes. Kernel: a config UI hint conversion that throws (a hand-made package)
  no longer fails the org extension list, the org config refusal or the channel connection schema:
  one never-throwing conversion serves the plain schema (hints stripped), else none, with one
  warning per schema. Plugin-tools: the packer refuses a packed `plugin.json` whose text is over
  `PLUGIN_MANIFEST_LIMITS.manifestChars`. Web: saving a replaced secret resets the deployment config
  form even when the view comes back unchanged; the install wizard and the upgrade dialog title the
  extension config card with its display name.
- 0ec51d1: Config UI hints: `ui(schema, hints)` attaches presentation hints (labels, help, widgets, options,
  sections, array items, presets, secrets drawn per item) to an extension config schema;
  `configJsonSchema` turns a config schema into the JSON Schema for forms (`x-ui`, `x-secret`,
  `x-hot`, titles from labels, no values under secrets) and `validateConfigUi` checks the hints.
  `secret()` now merges with existing meta. `plugin.json` accepts `extension.configSchemas`. The
  kernel's config JSON Schema now comes from the SDK (`hot` is emitted as `x-hot`).
  
  Compatibility (pre-1.0 ruling): a plugin packed by the new plugin-tools that declares config
  carries `extension.configSchemas`, which an older kernel's strict section parser refuses
  ("unrecognized key") rather than through the SDK range. Kernel and plugins move together before
  1.0, so upgrade the kernel before importing such plugins.
- 8e43ed7: A run waiting on its sub-agents reports `activity: "running"` (only a wait for a person is
  `waiting`, also for `state=waiting`), and a queued message sent to an archived conversation brings
  it back to the default lists, as a direct message does.
- 9b89920: A person can archive and delete their conversations. `PATCH …/conversations/:id` takes
  `{ title?, archived? }` (at least one), `DELETE …/conversations/:id` soft-deletes: it stops an
  active run, hides the conversation everywhere for its owner and drops its channel bindings, while
  the event log and trajectory stay. Archived conversations leave the default lists and a new message
  brings them back; views carry `archivedAt`.
- 258d286: Conversation lists and groups accept `q` (title search), `state` (running / waiting) and `archived=1`; rows carry `activity`, and groups report `archivedCount`.
- 69b3bbe: Create an organization from the web app. Skipping the organization in the setup wizard used to
  leave no way to create one in the UI.
  
  - `GET /api/v1/me` returns `canCreateOrg` (the deployment's `orgCreation` setting for this account).
  - With no organization and `canCreateOrg`, the status page offers "Create organization" (a name,
    then the new organization becomes the current one); the overview's header offers it too.
  - A page that needs an organization keeps its own title (e.g. Agents) instead of showing the status
    text as the title.
- 489d640: The current organization is remembered, and choosing or creating one covers the app until done.
  
  - **Remembered org:** choosing an org (`PUT /api/v1/me/current-org`) also stores it on the account
    (migration `0064_account_last_org`: `accounts.last_org_id`). A new web session (login, SSO, setup,
    an accepted invitation) starts in it while the account is still a member and the org is not
    deleted, else in the only org when there is exactly one. Setup with an organization name signs
    in with that org current. `GET /api/v1/me` reports no current org for an org the account left.
  - **Org chooser:** signed in without a current org, a full-page chooser (on the auth layout)
    replaces the shell: open one of your orgs or create one; the admin console stays reachable for
    enterprise admins. Creating another org later is at the end of the account menu's Organization
    submenu (it left the overview's header).
- 58d08b1: A deployment config secret whose only value is its schema default (for example openai-compatible's
  `apiKeys`, which defaults to `{}`) now reads as not set in the admin console instead of "set".
- 70688ca: Deployment config secret records drawn per item: for a secret record some `x-ui.secrets[].path`
  names, the admin config view adds `keys` (the record's keys that are set, never values), and
  `PUT /api/v1/admin/extensions/:name/config` accepts `secretEntries` (`{ path, key, value?,
  renameFrom? }`: set, remove or rename one key) applied under the config lock and validated with
  `values`. A path no hint names is 400 `validation_failed`, one in the startup config 409
  `extension.config_readonly`. The config view no longer fails when a schema's hint conversion
  throws (the hints are dropped with one warning), and a config-declared extension takes its display
  name only from a plugin.json of its own name.
- 49fa38b: A kernel whose stdout reader is gone no longer spins and ignores signals. When the reader of
  the console exits (the `tee` of `pnpm dev:kernel` stopped by Ctrl-C, a closed pipe), every log
  write failed with EPIPE as an uncaught exception, the process guard logged it (another write,
  another EPIPE), and the endless chain of errors held the CPU at 100% and starved the exit, the
  stop budget and a second signal. The logger now stops writing to a console stream after its first
  error, and the guard logs nothing more once it decided to exit. `pnpm dev:kernel`'s log file
  writer ignores Ctrl-C, so the shutdown's records reach `/tmp/capybara-dev-kernel.log` too.
- 0f1507e: Extension display names: an extension package stores its plugin.json `displayName`
  (`extension_packages.display_name`, migration 0066; packages stored before it have none until
  their next version), a config-declared extension reads it from its plugin directory's
  `.capybara-plugin/plugin.json`, and one resolver (`ExtensionDisplayNames`: the package, else the
  live catalog item of the same name, else null) adds `displayName` to the admin extension list and
  detail, the org extension list, both models lists (`providers[].displayName`) and the deployment
  config view. The config UI hint check can no longer throw out of an extension load, and stripping
  invalid hints leaves `default` / `const` / `enum` / `examples` values untouched.
- 80f4844: Extension config forms in the kernel: deployment, org and channel connection JSON Schemas carry the
  config UI hints (`x-ui`); invalid hints never fail a load, they are stripped from the schema with
  one warning per extension version and a note in the replica status. Config issues gain `segments`
  (the unjoined path) and `messageKey` (a custom issue naming a root `x-ui.messages` key). An
  unloaded install record's deployment config view returns the package's
  `extension.configSchemas.deployment` as `schema` (`validated: false`).
- 76da814: A background launch reservation is failed as `launch_abandoned` after twice the launch call's
  pipeline limit (the launch exec, the tool timeout, `sandbox.lockWaitSeconds` and the setup margin,
  at least 2 minutes) instead of a fixed 2 minutes, so a slow legitimate launch is never cut off.
- 8e928cb: Leaving an organization (`POST /orgs/:id/leave`) keeps the account's sessions and personal tokens;
  only that org's access ends. Removal by an admin and directory offboarding still revoke them.
- 81adaff: `GET /api/v1/orgs/:orgId/readiness` tells whether an organization can run: `modelProvider` is `ready` when a model-provider extension is loaded (from extension state, never a vendor call) and `agents` counts the agents the caller can see. The web app decides between the shell and the guided setup layout with it.
- 4ef89b8: Readable logs in the octok layout.
  
  - **Pretty console:** `[2026-10-30 12:00:00.000 +0800] INFO: [pid=…] - [traceId=…] [reqId=…]
    [queue=…] [jobId=…] [runId=…] [context=…] [plugin=…] msg`, each bracket only when present, with the
    other fields as indented `key: value` lines below instead of trailing JSON, and an error's stack
    below its message. The access line reads `GET /api/v1/me 401 2ms`. The process roles are no longer
    on every line (the start line names them; JSON records keep `role`).
  - **Context per class:** every kernel class's records carry `context` = its class name (JSON too).
    `KernelLogger` gains `child(fields)`.
  - **Nest's own lines** (`Mapped {/api/v1/…, GET} route` and module loading at startup) are logged at
    `info` with Nest's context, as octok does; they were at `debug`.
  - **Colors:** `FORCE_COLOR=1` forces colors in pretty output, `NO_COLOR=1` turns them off.
    `pnpm dev:kernel` forces them in the terminal and strips them from `/tmp/capybara-dev-kernel.log`.
- c01c117: The refresh cookie `cap_rt` is now set on `Path=/` instead of `/api/v1/auth`, so the web tier can
  renew a session while rendering pages on the server, and is `SameSite=Lax` instead of `Strict`, so
  a link opened from another site (an IM card, an email) still renews the session (the refresh
  endpoint stays POST-only behind the CSRF header). Every response that sets or clears session
  cookies also clears the legacy-path cookie, and `POST /api/v1/auth/refresh` accepts a `cookie`
  header carrying both values (it uses the first one that verifies). A browser that holds only the old
  cookie and an expired access token has to sign in once after upgrading.
- f28ed05: The PostgreSQL pool keeps idle connections for `db.idleTimeoutMs` (default 60 s, was pg's 10 s)
  with TCP keepalive, so requests after a pause no longer pay a new connection each against a distant
  database; long-lived Redis connections probe after 10 s idle and notice a dropped network early.
  Conversation titles ask the model for no thinking where it declares the `thinking` knob (a thinking
  model spent the 32-token budget on thinking and returned no title), and an empty title is logged.
- 2bd8351: Role pass: every page and action of the web app follows the viewer's org role.
  
  - A page the role may not open shows one designed "no access" state (what it is, the role it
    needs, who to ask) and loads nothing; the admin console uses the same state.
  - Navigation, ⌘K, the overview and agent actions only offer what the role may do; organization
    settings are open to members (read-only), never to guests.
  - New: leave an organization, delete an organization (owners, a danger zone with a typed
    confirmation), service tokens in organization settings (admins; the token is shown once), and
    changing an agent's owner (admins).
  - The kernel's readiness endpoint documents that `modelProvider` is deployment-wide and read per
    replica; role tests cover leaving, deleting an organization, service tokens and agent owners.
- c9c8625: A wait in a shared conversation names who has to act. `approval_requested` (and a sub-agent's
  `subagent_waiting` for an approval) records the approval's `requestedFor` and `approverRole`
  (display only, not model-visible; absent in older logs). The conversation page words a waiting
  call by it: "等待你批准" for the viewer, "等待 张三 批准" / "Waiting for 张三 to approve" for a
  member, the role for an approval escalated by role, and the run's starter for a question or a
  connection. The approval card tells a viewer who cannot decide whom it waits for, and a decision
  by someone else shows their name instead of their account id. The member list is read only when
  the log names someone other than the viewer.
- 8f7ba64: Sending in a conversation is instant: the composer clears on ↵ and the message shows at once as
  a pending bubble, replaced by the logged message without showing twice; a failed send puts the
  text and files back. A new conversation switches to the conversation layout at once and its page
  paints from what the create answered. From the send until the first output a walking capybara
  with a rotating caption ("规划中…" / "Planning…") shows where the answer will appear. While a run
  is going ↵ now queues the message for after the turn and ⌘↵ / Ctrl+↵ sends it now; a queued
  message shows in the queue at once.
  
  `POST /conversations` with a first message now also answers `events`: every event the create
  wrote, in seq order (a `model_switched` before the message when the send switched model or
  effort), so the new conversation paints without reading its log again.
- Updated dependencies [0ec51d1]
- Updated dependencies [8892d50]
  - @capybara-hq/plugin-sdk@0.1.0-rc.2

## 0.1.0-rc.3

### Minor Changes

- a1bfe76: `Write` on an existing file and `Edit` now fail unless the conversation has read the file (or wrote it itself) and it has not changed since. The decision comes from the file state each `Read`, `Write` and `Edit` result records in its display-only `view.file`, so every replica decides the same.
- 0f4b28a: The `Skill` tool takes an optional `args` string and renders the skill with it, as a person's `/name args` does.
- 8881b9a: Tool rows follow the Claude Code display: a builtin by its name (`Bash`, `Read`), a connector or
  extension tool as `<display name> [<tool>]` with the declared title as the tooltip, the key
  argument cut with `…`, and the expanded detail in `IN` / `OUT` blocks. `GET …/conversations/:id/tools`
  returns the parsed local tool name (`tool`) and an extension's plugin display name
  (`source.displayName`); approval views carry the extension and its display name; IM approval cards
  name the tool `<display name> [<tool>]` (no separate `appName`). Approval, inbox, grants, trajectory,
  agent policy and right-panel labels use the same rule; a `Write` that could not be diffed no longer
  shows `+0 −0`.

### Patch Changes

- 8bf0b04: The builtin tools take Claude Code's names: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
  `Deliver`, `Skill`, `SkillWrite`, `AskUserQuestion`, `ReadToolOutput`, `ToolSearch` and `Agent`
  (formerly `sandbox_bash` … `sandbox_deliver`, `skill_load`, `skill_write`, `ask_user`,
  `read_tool_output`, `tool_search` and `agent`). Every description, error and system text that names
  a builtin uses the new names; a request recorded before the rename is rebuilt with the old texts,
  so it replays with no drift. Several parameters are renamed as well (see the builtin tool
  parameters changeset).
- e1127f5: The builtin tools take Claude Code's parameters: `file_path` (`Read`, `Write`, `Edit`, `Deliver`),
  `old_string` / `new_string` / `replace_all` (`Edit`), `timeout` in milliseconds (`Bash`, a value
  above the deployment maximum is lowered to it), `skill` (`Skill`), `max_results` (`ToolSearch`)
  and, for `Grep`, `-i`, `output_mode` (`files_with_matches` by default, `content`, `count`), `-n`,
  `-A` / `-B` / `-C`, `head_limit` and `offset`. Calls recorded under the old names still replay.
- 307c611: The Claude Code tool-name map written into new skills snapshots is shorter: the tools that share a
  name with Claude Code are listed as unchanged. Importing a Claude Code agent maps `tools:` entries to
  the new builtin names (`Task` to `Agent`, `MultiEdit` to `Edit`, `TodoWrite` to
  `plugin__todo__write`); `mcp__*` entries are still dropped and reported in the translation report.
- 1beea7e: Full-run replay of recordings made under the release-candidate tool names: the recorded side is
  read in the current names (builtin keys and parameters, `<x>__<tool>` keys of connectors and
  extensions) before matching, so an old run replays with its recorded results and no tool-call
  difference; the result carries `legacyKeyMatch: true`.
- 56e83dd: A tool call logged under a release-candidate builtin key (`sandbox_bash`, `skill_load`, ...) that was
  still open when the tool names changed runs as the renamed tool with its parameters translated, and
  its result keeps the logged key. An approval of such a call given after the upgrade lets it run
  without asking again, and an `agent` call whose sub-agent was dispatched before the upgrade gets its
  result when the sub-agent finishes. A call to an old key that the request never offered gets the
  unknown-tool error plus a hint naming the new tool and its parameters.
  `GET …/conversations/:id/tools` answers an old builtin key as its current tool with `aliasOf`, so
  the conversation page shows old `agent` calls as sub-agent rows and old builtin calls with their
  current label.
- 48d3983: Stored release-candidate tool keys keep working. Migration 0063 rewrites the keys of tool grants,
  conversation grants, pending approvals and pending questions (`sandbox_bash` -> `Bash`,
  `<slug>__<tool>` -> `mcp__<slug>__<tool>`, `<extension>__<tool>` -> `plugin__<extension>__<tool>`);
  a key it cannot map (both a connector slug and an extension name, or neither) stays, and the
  kernel logs one `tools.legacy_key_unmapped` WARN with their count at start. Agent versions, agent
  templates and eval snapshots are read with the new keys. Saving a definition with an old key is
  refused with a message naming the new key. Remembered grants of builtin tools are asked again
  once (their tool definitions changed); connector and extension grants carry over. The migration
  also adds an index for the read-before-write lookup of `Write` / `Edit`.
- 32580d3: Model-visible tool keys of connectors are `mcp__<slug>__<tool>` and those of extensions
  `plugin__<plugin>__<tool>` (aligned with Claude Code). The SDK exports `parseToolKey`,
  `connectorToolKey`, `extensionToolKey`, `ParsedToolKey` and `BUILTIN_TOOL_NAME_RE`; hook payloads'
  `toolKey` carry the new keys, so an extension that matches keys should use `parseToolKey`.
- 75b1aaf: `Write` over an existing file now reads up to 10 MB of the old content to record its digest in
  `view.file`, and fails (instead of writing) when the old content cannot be read for a reason other
  than the file being gone.
- Updated dependencies [8bf0b04]
- Updated dependencies [32580d3]
  - @capybara-hq/plugin-sdk@0.1.0-rc.1

## 0.1.0-rc.2

### Patch Changes

- e23c2b6: `extensionHost.dir` defaults to `.capybara/plugins` under the working directory instead of
  `/var/lib/capybara/plugins`, so a kernel run from a source checkout can unpack its extensions
  without root; the image keeps `/var/lib/capybara/plugins` (set by `CAPYBARA_EXTENSION_HOST__DIR`).
- a0bc577: The Nacos config source also sends `tenant` with its config and listener requests, so a Nacos
  2.3 user granted only the configured namespace can read it (Nacos authorizes by `tenant` and
  answered 403 before).
- de0d460: The kernel is now one standard NestJS application (`createKernelApp` / `startKernelApp`): global
  infra modules (config, logging, the database with transactions, Redis, locks, cache, queues,
  schedules, throttling, health, validation), one module per domain whose services are injectable
  providers with one instance each, and the role modules `roles` selects (api, worker, gateway).
  One lifecycle provider owns the start order and the stop phases. Every concern is done one way,
  enforced by the new check `check:kernel-conventions`. Extensions are unchanged: they see only the
  SDK `ctx`, which the extension host builds from the injected services. HTTP routes, status codes,
  error codes and bodies, queue names, job ids, the event log, config keys and the SDK are unchanged
  except where noted below. The decisions made during the work are recorded in the appendix of the
  design spec (`docs/superpowers/specs/2026-10-28-nest-kernel-design.md`).
  
  **Operations**
  
  - **`capybara bootstrap` needs Redis.** The bootstrap step runs under the Redis lock
    `lock:bootstrap` (120 s TTL, renewed while it runs), in a starting kernel and in
    `capybara bootstrap` alike, instead of a PostgreSQL advisory lock, so compose `init` and a
    Kubernetes init Job need `CAPYBARA_REDIS__URL` as well as the database; the compose `init` service
    waits for valkey. During the rolling deploy that brings this change an old and a new process do
    not exclude each other; the step is recorded once per manifest and its writes are idempotent. The
    CLI's Redis connection keeps reconnecting, so a `capybara bootstrap` holding the lock survives a
    Redis blip.
  - **Periodic jobs** were BullMQ repeatable schedulers on the maintenance queue; they are now
    schedules inside the worker processes, each run once per period across all worker replicas
    (another replica's attempt logs at info). Names and periods are unchanged: `wait-sweep`,
    `usage-report-sweep`, `attachment-cleanup`, `storage-org-purge`, `sandbox-suspend-idle`,
    `sandbox-destroy-inactive`, `drift-scan`, `catalogs-refresh`, `output-cleanup`,
    `app-staging-cleanup`, `directory-scan`, `offboard-sweep`, `plugins-reconcile`,
    `channel-gateway-check`. A starting worker removes the old schedulers from Redis. They still run
    only on processes with the `worker` role, as do all queue consumers; an `api`- or `gateway`-only
    process builds no BullMQ worker and no scheduler.
    - A worker runs no periodic job before its start sequence (migrations, the bootstrap step, the
      extension load) has started its queue consumers; a tick that fires earlier is skipped with the
      info line `cron skipped: the scheduler is not started`. `catalogs-refresh` and `drift-scan` run
      once at that point, as their schedulers' first run did. At shutdown the schedules stop first and
      runs in progress are awaited within the stop budget, so a stop leaves no run lock behind.
    - Every hourly job now fires at the top of the hour (`attachment-cleanup`, `output-cleanup`,
      `app-staging-cleanup`, `directory-scan`, `storage-org-purge`, `sandbox-destroy-inactive`): the
      first run after an upgrade is at the next full hour. The 10-minute and 1-minute jobs fire on
      clock boundaries; their periods are unchanged.
    - A job whose run lock is lost (Redis outage, another holder) has its abort signal fired and a
      failure after the loss is logged at warn; only a job that reads the signal stops early (today
      `catalogs-refresh`). The others are idempotent sweeps and finish their pass.
    - A periodic job's name enqueued on `cap-kernel-maintenance` (by an operator or a test) runs that
      job once, as before; it is not a second schedule.
    - `sandbox-destroy-for`, `wait-timeout`, `drift-connector` and `directory-sync` stay one-off jobs
      on the maintenance queue (names, data, ids and retries unchanged: `drift-connector` still runs
      once), consumed by one maintenance processor on the worker role.
  - **Shutdown.** `capybara start` handles SIGTERM / SIGINT from before the start: a signal turns
    `/readyz` to 503 at once and aborts a start in progress at its next step; the stop phases, the
    queue and worker closes, and finally Redis, the bus and the pool (closed together) share the 30 s
    stop budget; a second signal exits 1 at once. Event streams close when the shutdown begins and
    later ones end at once. In-process events raised while the stop drains runs (a run finishing,
    an approval decided) are still handled, so IM final deliveries and resumes are not lost during a
    rolling deploy. With Redis unreachable the stop now uses the whole budget: queues and workers
    that cannot close are abandoned instead of holding the exit, and the pool still gets its share.
    The main Redis connection closes with QUIT.
  - **Unhandled errors.** `capybara start` logs an unhandled rejection or uncaught exception and exits
    1 only after more than 5 within 60 s (it exited on the first); other commands still exit on the
    first. A PostgreSQL restart while a pooled client is checked out is logged (`pg client error`,
    warn) instead of crashing the process.
  - **Leases give up on a deadline.** Every Redis lock and lease (the conversation run lease
    `capk:conv-run:<id>`, channel long-connection leases, sandbox and path leases, org run and eval
    quota slots) is renewed every third of its TTL and is lost at the send time of its last successful
    renewal + TTL − TTL/3, even with a renewal in flight, so a holder lets go one renewal period
    before the key can be taken elsewhere. Before, a conversation lease whose renewals failed until
    expiry kept running, so a second replica could start a second run on the conversation. After a
    Redis outage longer than about two thirds of a TTL a run is now re-queued (and resumes), a long
    connection reconnects, and a sandbox path lease is lost too; a lapsed quota slot lets the run or
    eval go on, so an org may briefly run more than its concurrency (for evals after an outage of
    about 40–60 s). A lost lease logs one `lock lost: <key>` warning (it replaces `channel lease lost;
    disconnecting`, `sandbox lease lost`, `sandbox path lease lost`, `org quota lease lost` and `eval
    quota renew failed`); a failed release logs `lock release failed` at warn (the key expires within
    its TTL). Keys and values are unchanged. A channel lease lost while its connection's config is
    read is no longer connected on. A shared sandbox lease renewed while it is being downgraded is
    no longer lost.
  - **Rate limits.** The credential limits (login, change password, setup token, invitation accept)
    keep their limits, codes, bodies and `retry-after`, and still fail closed when Redis is down;
    their counters move to `throttler:{cred:<group>}:…` (from `capk:login-fail:*` / `capk:rl:*`),
    so the counts reset once at deploy.
  - **Directory sync** takes its per-(org, extension) lock as `lock:directory-sync:<org>:<plugin>`
    (was `capk:directory-sync:<org>:<plugin>`): during a rolling deploy an old and a new replica may
    each run one sync of the same pair (harmless: the dirty flag and idempotent writes cover it).
  - **Model list cache** keys are `cache:capk:models:…` (old keys expire by TTL), and the cache fails
    open: a Redis error lists the provider's models again instead of failing the request.
  - **After-commit work.** Notifications after an org extension config write, an extension install,
    state change or uninstall, and an org plugin uninstall run after the commit; a failing one is
    logged and no longer turns the committed request into a 500. After-commit work always runs
    outside any transaction, and kernel bus handlers run outside any transaction and without the
    log context of the code that subscribed.
  - **New error code** `lock.acquire_failed` (409, with the lock key in `details[0].lockKey`; en and
    zh copy in the web app): raised when a kernel lock cannot be taken in time. No route raises it
    today.
  - **Validation.** The UI `:plugin/:id` and file preview `:plugin/:previewerId` routes validate their
    parameters with DTOs: `validation_failed` names the parameter in `details[].path` (was `""`);
    code and status are unchanged.
  - **Swagger.** New config `http.swagger` (default `false`, `CAPYBARA_HTTP__SWAGGER`) serves the
    OpenAPI document and UI at `/docs` (unauthenticated: development and trials only).
  - **CLI.** A kernel that cannot even be built now logs `kernel start failed` (was `cannot load
    configuration`); the exit code is still 1. `capybara admin create` / `admin grant` still need
    only PostgreSQL.
  
  **`@capybara-hq/kernel` API (breaking)**
  
  - Removed: `createKernel`, the `Kernel` facade type, `KernelOptions` and `KernelRuns`. Build the
    kernel with `createKernelApp(config, options)` (started, not listening, no signal handlers) or
    `startKernelApp(config, options)` (started, listening, SIGTERM / SIGINT handled), stop it with
    `closeKernelApp(app)`, reach its HTTP side with `kernelAppHttp(app)` / `kernelAppPort(app)` and a
    service with `app.get(Class)`. The options are `KernelAppOptions` (the old `KernelOptions` fields
    `loop`, `runHooks` and `evalHooks` are gone).
  - Removed: `createHttpApp`, `CreateHttpAppOptions` and `HealthOptions`; there is no standalone HTTP
    app any more, only the kernel application's (`KernelHttp` and `KernelHttpApp` stay).
  - `KernelAppOptions.overrides` is for the kernel's own tests only: it takes values for the named
    seam tokens of `KernelOverride` and refuses any other token when the application is built, so no
    kernel service can be replaced. The seam tokens are not exported.
  - The type `KernelDb` (the `capybara` schema view, a `Kysely<KernelDatabase>`) is renamed
    `KernelSchemaDb`; `KernelDb` is no longer exported.
  - Every exported service class (`ExtensionHost`, `ExtensionInstalls`, `ExtensionLifecycle`,
    `ExtensionAdminOps`, `BootstrapService`, `SandboxService`, `StorageService`, `AccountsService`,
    `SetupService`, `SessionService`, `SettingsService`, `OrgsService`, …) is a Nest provider whose
    constructor takes the kernel's providers: take instances with `app.get(Class)` from an
    application or a CLI context instead of constructing them. Removed with that:
    `BootstrapServiceDeps`, `ExtensionAdminOpsDeps`, `ExtensionLifecycleDeps`, `LifecycleHost`,
    `SandboxServiceDeps` and `StorageServiceDeps`. The prefixing storage is the plain class
    `PrefixedStorage` over a `StorageSource` (an extension's `ctx.storage` and the CLI use it), which
    `StorageService` extends.
  - Moved or changed: `SetupService.createEnterpriseAdmin` / `createEnterpriseAdminIfNone` are on
    `AccountsService`; `BootstrapService.run` takes the plugin import it uses (`imports`);
    `rewrapDataKeys(handles, keyring)` takes the database handles of an application context
    (`{ db, txHost }`) instead of a Kysely and opens its own transaction; `ExtensionCli` exposes the
    command's application context (`app`) and `bootstrap` instead of `db`; `ExtensionLifecycle` no
    longer publishes the periodic reconcile itself (the worker's `plugins-reconcile` job does).
  - New: the type `KernelOverride`; `openKernelCli(config, opts)` (a CLI command's application
    context; `redis: false` leaves Redis and the lock service out), `openKernelCliOverPool(pool,
    opts)` (a context over a pool the caller owns and keeps open), `KernelCliOptions` and
    `AccountsModule`; `handleShutdownSignals` with `ShutdownSignalOptions` / `ShutdownSignalHandle`,
    and `installProcessGuards` with `ProcessGuardDeps`, `GUARD_CIRCUIT_LIMIT` and
    `GUARD_CIRCUIT_WINDOW_MS`.
  
  **`@capybara-hq/testing` API (breaking)**
  
  - `startTestKernel(config, opts)` (options unchanged, no `overrides`) starts the kernel with
    `startKernelApp` on a signal source of its own (no process-wide handlers) and returns a
    `TestKernel` `{ app, http, port, close() }` instead of the `Kernel` facade; `port` is
    `number | undefined` (undefined after `close()`). `app` is the kernel's Nest application, for
    tests that can import kernel classes; a plugin test drives the kernel through `http` and the
    helpers of this package.
  - The `Kernel` and `KernelDb` re-exports are removed; `TestKernel`, `KernelApp` (the Nest
    application type) and `KernelSchemaDb` are exported. `login(k, …)` / `joinOrg(k, …)` take any
    `{ http }`.
  - `createDualReplicaHarness` keeps its API; each replica starts with `startKernelApp`, and the
    harness's stop sends SIGTERM to the replica's own signal source, so a replica stops through the
    same shutdown path as `capybara start`. `createLocalAccount` keeps its signature.
  - Migration for extension tests: type the kernel as `TestKernel` instead of `Kernel`, call
    `k.close()` instead of `k.stop()`, treat `k.port` as `number | undefined`, and import the type
    `KernelSchemaDb` instead of `KernelDb`; `k.http` is unchanged. The official plugins'
    (capybara-hq/plugins) tests need the same migration.

## 0.1.0-rc.1

### Patch Changes

- 75d7a0c: The kernel logs through pino: records are `{ level, time, role, msg, ...fields }` (`time` replaces
  `ts`), redacted as before. New config `log.format` (`auto` | `pretty` | `json`) and optional Loki
  push (`log.loki.url` / `username` / `password` / `labels`). HTTP requests get a request id
  (`x-request-id`) and an access line; records carry `reqId`, or `queue` / `jobId` / `runId` in jobs.
- e69c9d6: The bootstrap step obtains its packages itself: once it is not done for the manifest, under the
  advisory lock and before writing anything, each pinned plugin comes from a `*.tgz` of the offline
  directory whose sha512 matches (any file name), else from `packages.npmRegistry`, verified against
  the pin (new error `bootstrap.download_failed`, 502). A done run reads no directory and no network.
  New config key `bootstrap.dir` (`CAPYBARA_BOOTSTRAP__DIR`, default `bootstrap`). `createKernel`
  takes `bootstrap: { dir? }` instead of `bootstrapDir`, and the dual-replica harness's
  `bootstrap.dir` is optional.
