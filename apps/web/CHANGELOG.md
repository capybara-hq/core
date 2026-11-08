# @capybara-hq/web

## 0.1.0-rc.13

### Patch Changes

- 8469cb8: The workspace 连接器 page is cards: every connector, and every connector template of a plugin on in
  the org that has no connector yet, switched off or not. Org admins 启用 a template and go straight
  to its input (补充配置); members 连接 a personal connector and, once connected, set 权限: their own
  允许 / 询问 / 禁止 per tool for their connection (`GET` / `PUT …/connectors/:id/tool-policies/me`,
  migration 0104). A connector tool call resolves the org's lock, the member's 禁止, the agent's
  setting (which may now be `allow` for a connector tool), the member's 允许 / 询问, then the org
  default. Connector templates and connectors show their plugin's icon, and the admin connector
  templates list and detail show the template's display name with the id as meta.
- 5f583ea: Phones: object list rows are compact (the ⋯ menu on the name line, the state at the end of the meta
  line, the row action at its right), the page head stacks with a wrapping description, the settings
  sub-nav sticks under the head, and the sidebar drawer lists 更多 in place and scrolls its middle as
  one region.
- 36705dd: On phones the new conversation pins the composer at the bottom, puts the greeting and a sideways
  scrolling agents row at the top and lists the agent's quick actions in between; the composer's
  environment, model and effort pickers become one options button with a bottom sheet (also in a
  conversation), the effort label is no longer cut in half, a tap on an agent or a quick action no
  longer pops the keyboard, and the composer stays above the iOS keyboard.
- f60b796: `GET /orgs/:orgId/conversations/groups` gives each group's agent its avatar and profile time
  (`agent.profile: { avatar, updatedAt }`, the agents API's shape), and the sidebar draws the group
  titles from it: the agent's pixel avatar or image shows on every page, not only when the agents
  list happens to be cached; an agent without an avatar still shows its initial.

## 0.1.0-rc.12

### Minor Changes

- 32b4dfa: Appearance settings and the admin themes page: 组织设置 › 外观 (the org's themes with their switches,
  the platform default locked on; the default theme and 允许成员自选; read only for members), a 外观
  section in 偏好设置 (the person's theme, or the org's lock line), the platform default theme in the
  deployment settings (内置主题 or a platform `all` theme; a refusal names the orgs where it is off),
  and `/admin/themes` with its detail beside the other platform component pages.
  
  Theme names come from the themes themselves on the admin pages; the switch-off, scope, disable,
  uninstall and update previews list the orgs whose default a theme is and how many people picked it;
  the platform default theme offers no scope or disable action. Pickers use the design
  `ThemeSwatchGroup` (one tab stop, arrow keys select).
- 54d3507: Themed first paint: the workspace and sign-in layouts read the viewer's resolved theme (the org's
  themes, or the platform default before sign-in), link its stylesheet in the streamed `<head>`, pass
  its logo and wordmark to the design system and use its favicon; the account row's scheme toggle is
  hidden under a single-scheme theme.
  Switching themes without a reload leaves only the current theme's stylesheet enabled.

## 0.1.0-rc.11

### Patch Changes

- 705be7e: The agent page's 渠道 section draws its connections as the same cards as the org 渠道 page (plugin
  icon, name, platform, unbound mode, state), on the page ground with 接入渠道 beside the heading.
- dbea14d: Deleting a platform plugin whose extension is still enabled is refused with 409
  `catalog.extension_enabled` (disable the extension first, as an uninstall requires); the admin
  plugin page says so in the delete confirm and links to the extension.
- cc0bca9: The device confirmation page labels unnamed connected environments with the shared environment
  name (a former default reads "Personal (<provider>)"), like the rest of the web.
- cafa6e4: A person's default environment left behind by a sandbox provider switch is now shown as
  「个人环境（Docker 沙箱）」 / "Personal (Docker sandbox)" (the provider's display name, not its
  plugin id), and switching back to that provider makes it the default again, with its files,
  instead of creating another empty default. Renaming such an environment makes it an ordinary one.
  
  Rolling deploys: replicas older than migration 0096 still rename a demoted default
  `Personal (<plugin id>)` instead of marking it; that is accepted before 0.1.0, so don't run old
  replicas alongside new ones across this upgrade.
- c3e12b3: A second enabled provider of a single-provider extension point now shows as a conflict (replica
  reason and status `conflict`, naming the provider in the way) instead of a missing dependency, and
  loads by itself once the other provider is disabled.
- ed929cd: The app shell, the pending frame, the login page and dialogs size to the dynamic viewport
  (`100dvh`), so on iOS the composer is no longer hidden behind Chrome's bottom toolbar and the
  page no longer scrolls under Safari's address bar.
- b84a7ce: On iOS the app shell puts the document back at the top once the keyboard closes, so the head is no
  longer stuck under the status bar after typing.
- ff9cd78: The workspace 插件 → 市场 tab shows plugin icons too: the org marketplace entries carry `icon`, the
  item's org icon when the org sees the imported plugin, else the marketplace icon on
  `GET /api/v1/orgs/:orgId/marketplaces/:id/icons/:sha256` (org admins, gated like the org browse).
- 2435645: Marketplace rows show icons: an imported plugin its catalog icon, otherwise the icon its
  marketplace entry names. The kernel downloads entry icons on refresh through the marketplace
  network rules (or reads them from a git marketplace's commit), keeps real svg / png files of at
  most 64 KiB in PG (migration 0101) and serves them to super admins on
  `GET /api/v1/admin/marketplaces/:id/icons/:sha256`; the admin entries carry `icon`. A bad icon never
  fails the refresh.
- 0c01fac: The 待确认 tab of the admin plugins page shows each plugin's icon, like the other tabs.
- f0433e1: A plugin's detail page (admin and workspace) shows its icon as the 40 px mark beside the title instead of
  a full-width image in the body.
- 48b244e: Plugin icons wherever the kernel shows something a plugin brings: channel connections
  (`pluginIcon`, `pluginDisplayName`), org and admin extensions, model providers and the catalog
  lists carry the URL of their plugin's icon for the reader's scope (org or admin icon route; null
  without one, or when the org may not see the plugin). The web draws it as the mark, falling back to
  the initial, and the org channels page is a card list.
- 4e6e44f: 接入指南 on 新建渠道 (once a plugin with a setup guide is picked) and on the channel detail page:
  the plugin's steps, each template file filled in for the channel in a code block with 复制, and a
  mode switch (长连接 / Webhook) when the guide has a file per mode. When a plugin upgrade changed
  the setup since the connection was set up, the detail page says so (「Slack 插件更新了接入配置」)
  with 「我已更新 Slack 应用」 to confirm.
- dbada5c: The properties panel as a sheet (narrow windows and phones) has a head with its title and a close
  button; on a phone the sheet covers the window and could not be closed.
- ae26039: A conversation under way offers its agent's quick actions in the composer, as a new conversation
  does; picking one fills the composer.
- f035baa: Switching a channel connection's inbound mode no longer clears the setup guide update notice: the
  mode switch moves the recorded guide on only when it shows no drift, so the notice stays until a
  person confirms 「我已更新应用」. The 接入指南 says why a variable has no value (saving the
  channel on 新建渠道, or the public address and webhook address a super admin sets in the
  deployment settings), and the guide read is keyed by the plugin version so an upgrade shows the
  new manifest.
- 0e8592b: A single-provider extension point (sandbox, object store, secret store, config source) takes one
  enabled provider: enabling a second one is refused with 409 `extension.single_provider_enabled`
  (disable the current one first), an import or bootstrap preinstall of a second one is installed
  disabled and says why, and two left enabled from before load the earliest enabled on every replica
  and after every restart (`extension_installs.enabled_at`, migration 0097). The admin console turns
  启用 off with a line naming the provider to disable and a link to it.
- cb6f42d: Single-provider extension points, follow-ups. An upgrade of an enabled extension whose new version
  newly provides a single-provider point another extension holds installs the new version disabled
  and says why (`leftDisabled`, the import / update / bootstrap results) instead of silently taking
  the point over. A required bootstrap entry whose point is held fails the bootstrap ("disable
  <other> and run the bootstrap again"). A point a required plugin holds cannot be replaced: 409
  `extension.single_provider_required`, and the admin console says so. Refusals name the provider
  actually loaded. When the elected provider fails to load, the admin console warns that the point
  has no running provider.
  
  Upgrading: a deployment that already had two enabled providers of one point (from before the
  one-provider rule) could switch providers on the rolling deploy, because migration 0097 picks the
  one enabled first by the audit. Migration 0098 prefers the provider replicas are running (a
  `loaded` replica status row, most recent heartbeat); with no such row the 0097 order stays, and the
  provider may change: check the admin console after the upgrade and disable the one you don't want.
- dfd6abc: `/device/connect` upgrades go to `CAPYBARA_KERNEL_URL` when `CAPYBARA_WEB_GATEWAY_URL` is unset, so a single kernel process (every role, as in development) needs no extra setting; only deployments with separate gateway replicas set it (compose does).

## 0.1.0-rc.10

### Patch Changes

- 7ce35ab: Connected environments in the web app: the `/device` page confirms a `capybara-device login`
  (the code, the machine, the org, a new or existing environment and the disclosure); 新建环境
  offers 云端沙箱 or 接入设备 (the install and login commands, then waits for the machine); the
  environment page shows the machine with 断开这台机器; the picker lists connected environments
  with 在线 / 离线 and an offline one cannot be chosen.
- cfdf1f0: The web server forwards connected machines' WebSocket upgrades on `/device/connect` to a gateway
  replica (`CAPYBARA_WEB_GATEWAY_URL`); compose puts web and gateway on a `devices` network.

## 0.1.0-rc.9

No changes in this release.

## 0.1.0-rc.8

### Minor Changes

- e53c2be: The agent's Tools section and the agent template editor start with every tool checked: unticking a
  tool turns it off for the agent (or template), and an extension or connector row reads 全部开启 /
  已关闭 N 个 / 已关闭全部. The sandbox builtins are listed too; the sub-agent panel names the tools
  the child's first model call offered.

### Patch Changes

- 911f33c: The agent and agent template pages' skills section reads as titled regions (org skills, pinned,
  and skills the agent wrote): empty states with a way to the skills page, the pinned count at the
  heading, the write confirmation next to the agent's own skills, and shorter copy.
- 7c38183: The admin extension Sheet offers 清空配置 / Clear config while a config is saved there, after a
  confirm. A list's remove button at its minimum now looks disabled and its tooltip says why
  (「至少保留 1 项」).
- 6b4b451: Credentials never travel in a URL: every form posts, and when the client JS does not load the
  proxy completes sign-in and setup server side (a GET with credential fields is redirected without
  them). `CAPYBARA_WEB_DEV_ORIGINS` lets the dev server serve its scripts to LAN addresses.
- fac6134: The agent page's Tools section lists the `CurrentTime` builtin as 获取当前时间 / Current time.
- 68db6e8: Empty states now follow the space they fill: an empty settings page (my connections) shows the page empty state, an empty list or region inside a card, Sheet, Dialog, right panel or properties section (an agent's channels with 接入渠道, a tool group, an extension view such as the task list with no tasks) shows the small centered capybara, and an extension view with nothing in it is no longer a blank body.
- b189ebb: The login page's http notice is one sentence for people; the operator details (the cookie and public
  URL settings) moved to a warning on the deployment settings page, a kernel startup warning and the
  deployment docs.
- b79752e: `/settings/models` picks the provider with a select instead of a providers column; the model tables keep every column on screen (names wrap, descriptions clamp to one line, publishers show in full), and 全部开启 / 全部关闭 share one button style.
- 7585e69: The models pages (`/admin/models`, `/settings/models`) have two tabs, 模型 and 用途默认 (`?tab=`): the providers sit beside the open one's models (`?provider=`), grouped by kind with each kind's own columns.
- 6f07ade: The skills an agent wrote are an item list: a long description wraps inside the card and the delete
  button stays in it.
- 1302477: The composer's model picker heads each group with the provider's display name, not its plugin id.
- 56cfd99: After an agent changes something through the Platform tool, the pages show the change without a
  reload: the conversation stream marks the cached reads stale.
- 8a016b4: Platform tool phase 2, workspace and admin operations: about 95 new operations.
  
  - **Conversations** (your own): list, read, events, usage, files, sub-agents, the agent tree, the
    environment, rename, archive and unarchive. Delete and stopping another run of yours are never
    remembered. The new static `rememberable: false` marks an operation that always asks.
  - **Skills and components**:
    - switch a skill, agent template or connector template on or off in the org;
    - share and delete skills;
    - for the super admin, component scope, deployment disable and "shown to other orgs" (all with
      previews), and updating an agent template.
  - **Admin console** (super admin, own private agent only):
    - accounts: list, read, create, disable and enable;
    - orgs and their limits, deployment settings, models, prices and the default model per purpose;
    - plugins, extensions and marketplaces: deployment state, enable, disable, upgrade, scope, and
      import prepare.
  
    Admin data is shown in full. Items owned by other orgs are counted and refused.
  - **Creating a user** takes no password:
    - the kernel generates a one-time initial password;
    - it is shown once, on the web, only to the super admin who approved;
    - it expires after 24 hours, and an hourly job removes unread ones;
    - the account must change it at first login.
  - **Fence**: `check:platform-ops` gains `platform-op-double`, which reports a route that is both
    mirrored and excluded.
- 89b1439: Platform tool phase 2, foundations:
  
  - **Shared schemas.** Operations build their input from their route's exported schema. A parity
    test fails when they drift apart: a type, bound, pattern or required field, a nested or renamed
    field, or an undeclared omission or extra. Deliberate differences are declared with `omits`,
    `extras`, `renames` and `loosens`.
  - **Checks before the card.** Writes run a read-only `precheck` before the confirmation card. When
    the write is known to fail, the tool returns the reason and no card appears. The precheck runs
    again on resume after approval.
  - **Errors with a next step.** Errors name the next step for the actor's role (super admin, org
    admin or member). `check:platform-ops` gains `platform-op-errors`.
  - **Why an extension is unavailable.** An installed extension that is not loaded now says why. The
    org extensions API gives its deployment `status` and a `reason`, such as
    `needs_deployment_config`, `pending_approval` or `failed`. A plugin not on in the org whose
    extension cannot run is `unavailable` with the same reason.
    - The 扩展 and 插件 pages show it (不可用 · 缺少部署配置) with the next step for the viewer's
      role. The super admin also gets the admin console link.
    - `plugins.set-enabled` refuses such a plugin before the card.
    - `plugins.list` and `extensions.list` return compact rows with `state`, `reason` and `next`.
- 1a2bcf6: Every message send carries the browser's time zone and UI language; a new personal 偏好设置 page
  sets a time zone (default: follow the browser) and the org settings page an org default time zone.
  The agent page saves its description into the agent's version, so the agent knows it.
- 7ad02b6: On a settings page, a section's tabs sit in the content column beside the settings navigation, not
  across the whole page.
- 4ba4249: Text fields are 16px on touch screens, so iOS Safari no longer zooms the page into a focused field.

## 0.1.0-rc.7

### Minor Changes

- 79fbc11: The models pages group models by kind, show publisher, description and retirement date, let the platform and org admins disable single models or a whole provider, and offer only models of the right kind in the pickers.

## 0.1.0-rc.6

### Minor Changes

- d423777: Agent templates: the 智能体 page has the tabs 智能体 and 模板 and shows both as cards
  (`/agent-templates` redirects to `/agents?tab=templates`), the admin 智能体模板 list uses cards too.
  A template card and the new template page (`/agents/templates/<id>`: the read view for members, the
  editor for org admins) open 用它创建, a dialog with the 带入 / 待配置 / 不可用 preview; the new agent
  shows its template and a 待配置 notice in Tools where an admin configures each connector (an existing
  one, one more from the template, or the prefilled custom form) and a member sends or repeats a
  request. Org admins save an agent as a template from its card or page, and the inbox shows
  connector setup requests with the same configure dialog.
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
- 2a12327: Marketplace entries accept `deprecated: true | { reason? }` (SDK `MarketplaceEntry.deprecated`,
  normalized by `marketplaceEntryDeprecation`; JSON Schema regenerated). A maintainer sets it by hand
  on a published version's entry; `capybara-plugin marketplace --write` keeps it, and the `--base`
  integrity rules ignore it. The kernel returns `deprecated` on marketplace entries, never reports a
  deprecated version as newer or as an item's latest marketplace version, picks the newest stable
  non-deprecated compatible version when an import names none, and refuses importing or requesting a
  deprecated version with 409 `marketplace.entry_deprecated`. The market lists show the newest stable
  version on each row (prereleases fold into 其他版本 unless no stable version can be imported) and
  list deprecated versions under 其他版本 as 已废弃, with the reason, not importable.
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
- 26e8757: Workspace platform components: the 技能 page lists the org's own skills and the platform skills offered to the org with their state and the org admin's switch (已启用 · 平台统一 for `all`), a new 智能体模板 page lists agent templates the same way, the plugin detail lists its components with per-component switches, and an installed plugin missing a connector offers 补充配置. The kernel adds `GET /orgs/:orgId/components`, serves a linked skill copy's detail as its platform skill, and names the missing connector templates in the org catalog detail. The agent editor treats linked copy ids as their platform skill or template; the inbox shows decided requests.

### Patch Changes

- 49ae0b5: Agents can select extension tools: the agent page's Tools section lists the tools of the extensions
  enabled in the org (new `GET /api/v1/orgs/:orgId/tools/extensions`) and adds or removes their
  references; a selected tool that is unavailable stays listed as unavailable with the reason.
- e555e04: The agent map opens one sub-agent's summary (latest text, task, background tasks, tool calls newest
  first, Stop while it runs) and its read-only transcript; an `Agent` call block names the child's
  current tool and opens it in the map. A sub-agent's reports and its end show in the parent as notice
  lines, and a parent's messages in a sub-agent's transcript as bubbles labelled with the sender.
- 1556a45: The conversation page opens an agent map of the conversation's sub-agents (from the sub-agent
  group's header and a title-bar icon), kept in the URL hash; the org sub-agent limits dialog sets the
  nesting depth and counts dispatches and tokens over the whole tree since the person's latest message.
- 6634b82: The new conversation page's agent row now shows placeholder chips while the agents load, so the composer no longer jumps down when they arrive.
- 3a4b54b: The agent page's Tools section puts each tool's policy on its row (a new `ToolPolicyList`): the
  built-in tools stay in the card, and each extension or connector is one row with a summary that
  opens a Sheet with its tools, select-all and a filter. A connector can now be taken tool by tool.
  The connector detail's tools carry their display `title`.
- 266fc77: The agent page shows the same-provider fallback hint in the Model section, persistently and live
  while editing, instead of in whichever section was just saved.
- 07d9e23: The composer's 「N 个智能体」 chip always leads with a mark (the agent icon, or the status dot while
  a sub-agent runs or waits), draws its number in ink, and shows 「· 3 个运行中」 / "· 3 running" while
  some are active. Browser extensions that add attributes to `<html>` no longer raise a hydration
  error.
- 5854ae0: Cards on the page ground: the design system's new `CardGrid` and `ObjectCard` (avatar or icon, the
  name as the card's one link, a two-line description, a meta line, one primary and a menu; roving
  focus by row; loading and empty shapes) and `ListPage variant="cards"`, for the agents page and the
  template lists of plugin scope phase 4.
- ff6d4d4: The agent map's entry moves from the conversation title bar into the composer: a chip
  「N 个智能体」 / "N agents" after the effort picker and the quick actions, led by the status dot
  while a sub-agent runs or waits, with the running count in its name. Long user messages fold to
  eight lines with 展开 / 收起 ("Show more" / "Show less"), pending bubbles included.
- 16225b1: `GET /api/v1/orgs/:orgId/connectors/kinds` lists the connector kinds whose extension is enabled in the org, with the plugin providing each. The connector install wizard offers only those kinds, and with none it points to Plugins instead of failing at the end.
- 3c0ad62: A conversation's history loads from the end: the page paints the log's last page and reads earlier
  pages as the reader scrolls up, without moving what is on screen. `GET …/conversations/:id/events`
  takes `before=<seq>` or `before=end` for a turn-aligned page (it starts after a run's end) with
  `turnsBefore`, the runs started before it. Sub-agents, usage and background tasks are read from
  the server when the loaded part may hide them.
- 0a44cea: The extension Sheets say each thing once: one notice for missing config, localized field errors, titled regions with one facts block, and the save in the footer.
- abc772e: Switching on an extension whose org config has a required field that was never saved is refused
  with the plain 400 `extension.config_invalid` and its field issues before the plugin installs
  (no 502 `plugin.install_failed`); a `config` sent in the same PUT goes into the install. On the
  扩展 page the switch of such an extension waits for the config (先填写组织级配置再启用), the
  config form offers 保存并启用 (config and switch in one PUT), and a refused config marks the
  form's fields.
- 5ad753b: The 扩展 pages (workspace and admin console) are a list by capability: tabs 全部 / 模型 / 网页 /
  连接器 / 沙箱 / 存储 / 工具与界面 with counts and a search, rows needing attention first, and a
  details Sheet per extension with its config on top, its state and its permissions folded into one
  line. The workspace switch, the config-first rule and every toast are kept.
- 357c521: A sub-agent that handed back its report and then completed no longer sends its parent a separate
  "completed; its report was already delivered" notice: the finish is only logged, so it neither
  wakes an idle parent for an empty run nor pushes the report away from the end of the request. The
  conversation still shows the agent's "completed" entry.
- 1db93f1: The new conversation (the setup layout while the org is not ready) is now the workspace home at `/`; `/chat` redirects permanently to `/`, keeping its query, and `/chat/<id>` is unchanged.
- 12fd552: Marketplaces list one entry per plugin. `plugin.json` `description` accepts `{ en, zh? }` as well as a string (English; read it with the SDK's `pluginDescription`), and marketplace entries accept an optional `displayName: { zh, en }`. `capybara-plugin marketplace --write` keeps one entry per public plugin at its current version, with `summary` from the localized description and `displayName` from `plugin.json`, replacing a plugin's entry when its version moves; `--check --base` replaces `marketplace-append-only` with `marketplace-version-decrease` (an entry's version only increases) and `marketplace-integrity` (a published version keeps its integrity). `capybara-plugin check` warns, without failing, when a public plugin's description has no `zh` (`release-description-zh`; findings may now be warnings). The kernel returns an entry's `displayName` (null without one) and searches it, and a single-plugin git marketplace takes the summary and display name from `plugin.json`; a catalog item keeps the English description. The market lists show the display name, else the name. model-fake gets a Chinese description.
  
  `--write` also refreshes a listed entry's `summary` and `displayName` from `plugin.json` (`marketplace-display-stale` in `--check`), and `marketplace-version-decrease` also fires when a plugin moves back to an older version a base in the older form lists. Catalog item views (admin and org) and the import review carry `descriptionZh` (the latest version's Chinese description, or null), and the plugin pages show the description in the UI language.
  
  Release order: release core and upgrade the deployed kernels before `capybara-hq/plugins` publishes
  plugins whose `description` is an object (older kernels reject it) and before the official
  marketplace drops older versions.
- 593904e: One box is enough: inside a card, form card, dialog, sheet, inline card or property section the
  design system groups with headings and hairlines instead of a second box. Tables, code blocks,
  embeds and repeaters draw their unboxed form there by themselves; new `ItemListItem`,
  `Subsection`, `Grid divided` and `Text variant="h3"`; the narrow properties sheet draws its
  sections as hairline groups; loading shapes for item rows replace the card shapes in form cards.
- fa499bb: Two-level extension config forms: the org form shows the platform's values (following) or the org's own copy, with compare, take and use-platform; the platform form tags each field with what orgs may do; the admin extension detail lists the orgs with a copy and shows "running, orgs configure their own".
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
- 26c0105: Model purpose rows show no purpose ids: a kernel purpose says what happens while it is unset, an
  extension's purpose names the extension, and the org page's default option names the deployment
  default. The eval run's version picker marks the current version and shows each version's saved
  time.
- 20e10d0: Config form lists: add buttons name what they add, nested lists add inside their item, item titles follow the name field, and a new item shows no required errors until a field is left.
- 17fc2fe: Segmented controls in form fields (model parameters, extension config forms) fill the field with equal segments.
- 9097b8e: A reload of a conversation paints its sub-agents' decided approvals decided: the approvals and
  questions the log names only by id are read before the first paint, and a card whose state is not
  read yet draws nothing instead of a pending approval.
- 726266c: A sub-agent that ended on a limit (token budget, step or time limit) reads 「已达上限」 / "Limit
  reached" in amber in the agent map, the stream and its legend, not as a red failure. The admin org
  limits dialog shows each deployment default as the empty field's placeholder and the orgs table
  「默认（5,000,000）」; sub-agent dispatches and tokens get a 「不限制」 checkbox.
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
- 5497dc8: Boxes read as titled sections instead of piles of text: change previews (update, switch-off, scope, disable, delete, uninstall report) are titled groups of rows, the eval result Sheet has sections with the labeling in its footer, detail pages put their facts in one block and their notes in one notice, and the extension replicas table gives the reason the room.
- 527d703: Toasts sit at the top center, newest on top, with a leading status icon instead of a color stripe,
  and names in toast messages are quoted.
- cfee6f0: The model is told when its tool set changes mid-conversation: a step whose resolved tools differ
  from the previous request's logs a `tools_changed` event (added and removed tool names) before its
  request, rendered as a system message ("Your tools changed. Now available: … No longer available:
  …"). Step replay rebuilds it from the log with zero drift; the web timeline ignores it.
- e18ee24: UI terms: the web app reads and sends the kernel's renamed `isSuperAdmin` / `superAdmin` /
  `orgCreation: "super_admin"`. Chinese copy says 超级管理员 (was 企业管理员), 平台 for the deployment
  layer (平台目录, 已启用 · 平台统一, 平台提供的插件), 自定义市场源 for a non-official marketplace,
  智能体 for agent (nav 智能体, 新建智能体, 子智能体, 智能体模板), and the role names 组织所有者 /
  组织管理员 / 组织成员 / 访客; English says Super admin, Platform, Custom marketplaces and Org owner /
  Org admin / Org member / Guest. The CLI says "super admin" in `capybara admin create | grant |
  revoke` output and help (`super admin already exists; skipped`, `super admin created`).
- 694dba2: A conversation's `changed` frame that arrives while the page's first read of that part is still
  on its way now reads it again. The properties panel could miss a background task started right
  after the page read the empty list, until the task finished.
- 83fec11: Form selects and the conversation composer (acceptance batch 3).
  
  - Every form select opens the design system's own list instead of the browser's popup: the
    composer's anchored menu as a listbox, below the field (above it when the room below is short),
    at least the field's width, capped in height, the selected option checked; a filter above ten
    options; arrows, Enter, Space, Escape and typeahead; forms still submit and validate it.
  - Space on a focused item of a filterable menu picks it.
  - On a conversation the composer no longer repeats the agent: the title bar's path names it.
  - The zh copy calls an agent's owner 所有者 everywhere (never 负责人).
- 8ee4c6c: Sending while a reply streams posts an interjection placed where the run absorbs it, with no queue UI; a reloading or reconnecting stream, or a switch between running conversations, resumes the streaming reply without a gap or a duplicate.
- da49ebd: Copy: the English UI says "org admin(s)" for the role everywhere, the site description reads
  "Agent platform for organizations", and the Chinese settings hint says 组织管理员.
- 47c4241: The workspace has no home page any more: the new conversation is the home. `/` redirects to `/chat`,
  新会话 is the current nav item there, and sign-in, setup, an org switch, the not-found page and the
  path's org scope all go to `/chat`. The sidebar reads 新会话 · 智能体 · 技能 · 连接器 · 更多; 技能 and
  连接器 left the 更多 flyout, which keeps 插件, 扩展, 智能体模板, 渠道, 评测与运行 and 组织设置.
- Updated dependencies [789068d]
- Updated dependencies [3c45446]
  - @capybara-hq/design@0.2.0-rc.1

## 0.1.0-rc.5

### Patch Changes

- fce12a1: The web tier keeps idle keep-alive connections open for 65 s instead of Node's 5 s (plus its 1 s
  buffer), configurable with `CAPYBARA_WEB_KEEP_ALIVE_TIMEOUT_MS`. A load balancer or client reusing
  a connection just as the web tier closed it got a reset (a 502 at the proxy) before the request
  reached Next.

## 0.1.0-rc.4

### Minor Changes

- 57cb7d0: Every web read goes through TanStack Query. A first load still paints complete from the server
  (the layouts prefetch the route's reads from one route table and hand them to the browser's
  cache); navigating inside the app reads from that cache: a page seen within its freshness window
  paints at once with no kernel read, a stale one paints and refreshes in the background, and a page
  with nothing cached shows its template's loading state. Saves invalidate exactly the data they
  change, an org switch or sign-out clears the cache, and a missing object shows the not-found state
  inside the shell.
- e19c40b: Web: the org extensions page has a "Default providers" section for extension points several
  enabled extensions provide (`web-search`, `web-fetch`), with a "not selected" state while none is
  chosen; the agent page's Tools section offers the builtin `WebSearch` and `WebFetch` tools (not
  checked by default) when the org has a provider for them, and keeps them listed for an agent that
  already selected them; `usage` events with `purpose: "web_fetch"` don't count as the
  conversation's context. The Tools section's "no usable web provider" notice also covers several
  enabled providers with no default chosen.

### Patch Changes

- a5f8fdb: The new-agent form asks for an avatar, a name and a model, then lands on the agent's Prompt section.
- bbf7e93: The agent page's Prompt section edits named `.md` prompt files (add, rename, delete, reorder, with
  the joined character and file counts), and Model, Tools, Skills and Sub-agents each save only
  their own fields with the version they were edited on, offering a reload when it is stale.
- 88f1206: The agent page is sectioned (`/agents/<id>?s=<section>`): a section nav, Basics (avatar, name,
  description, visibility and members) and Quick actions with their own saves, a confirm before
  leaving unsaved edits, and a read-only basics, quick actions and model for people who cannot edit.
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
- 9e9ce5b: Config forms review fixes. Kernel: a config UI hint conversion that throws (a hand-made package)
  no longer fails the org extension list, the org config refusal or the channel connection schema:
  one never-throwing conversion serves the plain schema (hints stripped), else none, with one
  warning per schema. Plugin-tools: the packer refuses a packed `plugin.json` whose text is over
  `PLUGIN_MANIFEST_LIMITS.manifestChars`. Web: saving a replaced secret resets the deployment config
  form even when the view comes back unchanged; the install wizard and the upgrade dialog title the
  extension config card with its display name.
- c866d10: The conversation thread reserves a classic scrollbar's gutter on both sides, so it stays aligned
  with the composer once it scrolls.
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
- 1325a21: Design: three pieces for extension config forms. `Repeater` draws an array of objects as hairline
  item cards (title, subtitle, drag handle, move up / down, remove with an undo toast, collapse) or
  as compact rows, with an add button or a menu of presets plus 空白, Alt+↑/↓ to reorder and focus on
  the new item's first field; `FieldRow` is a compact row of small fields with labels on the first
  row only, a per-row 高级 disclosure and a stack below 640; `KeyValueEditor` edits a record as key /
  value rows. Menu items may carry a description, and a success toast may carry an undo action.
- f447152: After the first send from a new conversation, `/chat/<id>` no longer reads the row, queue and files
  again: the first stream open of a seeded conversation is not treated as a catch-up.
- 15af7fd: Server-rendered times no longer break hydration. Until a page has hydrated it writes relative ages
  ("现在", "1 分钟前"), running durations and local dates with the clock and time zone of the server
  render, then switches to the browser's: an age that crossed a minute between the server render
  and the hydration, or a viewer in another time zone, used to fail hydration (Next's error overlay
  in development) or keep the server's times. The browser's time zone is saved in the `cb-tz`
  cookie, so later server renders write dates in the viewer's zone.
- 8e928cb: Leaving an organization (`POST /orgs/:id/leave`) keeps the account's sessions and personal tokens;
  only that org's access ends. Removal by an admin and directory offboarding still revoke them.
- d799c3d: The light theme is lighter (page `#FAF9F6`, sidebar `#F3F2EE`), and its hover, selected and
  current grounds are now translucent ink overlays, so hover and the selected segment read on the
  sidebar too (the conversation filter, the theme switcher) and the settings sub-nav hover shows.
- d875104: Pages no longer jump when their data arrives: the loading states of the eval run, eval set,
  connector, catalog item, skill and channel pages, the inbox and catalog requests, the overview,
  the run wizard, the new channel and new agent forms, the agent page head, the organization
  settings and the invitation and binding pages now draw the loaded page's shape (its stat cards,
  tables, inspector, decision row, cards and buttons), with the parts the page already knows real.
- 3021acc: The new-conversation page shows a skeleton until the agents, the models and the recent agent are
  known, instead of flashing a composer full of placeholders before the setup checklist or the real
  composer appears.
- 0f58f68: The new conversation page greets by the time of day, shows the agents row (most recent first, at
  most five, the rest in a searchable panel) and the selected agent's quick actions; a quick action
  fills the composer, and ⌘Z / Ctrl+Z brings back the text it replaced. Agent avatars show in the
  agent list, the conversation title bar and the sidebar's group titles.
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
- d749f45: The guided setup layout takes the shell's shape: the design system's `SetupPage` is now the sidebar,
  the content area and the status bar, with the sidebar in a new setup context whose navigation is
  "开始之前" and the setup steps (each with a done, to-do or waiting mark and, while waiting, the
  reason), the optional steps under "可以稍后再做"; the rail and the drawer work as in the shell. Design
  links show a 2 px accent underline while their navigation is pending (`DesignProvider`
  `useLinkPending`, fed from next/link's `useLinkStatus`).
- 433ba63: A deployment without an admin goes to the setup wizard on the server, before any page is painted
  (`/`, workspace pages and `/login` redirect to `/setup`; `/setup` redirects to `/login` once set up).
- 7eb859f: The setup checklist's step buttons are links, so a click before the page hydrates is no longer lost.
- 9274374: A sub-agent that waits for a person shows no spinner and no running clock, in the thread and in
  the properties panel's background section: its row says what it waits for, and a sub-agent group
  whose every active child waits says so in its header instead of "N subagents running".
- de60e29: Conversation tool rows: a call waiting for a person (a question, an approval or a connection)
  shows "Waiting for your answer" / "Waiting for your approval" instead of a spinner and a growing
  timer; the AskUserQuestion row reads "Asked <header>"; running tool rows, group headers and
  sub-agent rows draw the 16 px spinner the thinking row uses.
- ed3ddd2: An extension view refreshed while an older read of it was still in flight (for example right after
  sending a message) is read again once that read ends, so a panel no longer keeps the view from
  before the change.
- c9c8625: A wait in a shared conversation names who has to act. `approval_requested` (and a sub-agent's
  `subagent_waiting` for an approval) records the approval's `requestedFor` and `approverRole`
  (display only, not model-visible; absent in older logs). The conversation page words a waiting
  call by it: "等待你批准" for the viewer, "等待 张三 批准" / "Waiting for 张三 to approve" for a
  member, the role for an approval escalated by role, and the run's starter for a question or a
  connection. The approval card tells a viewer who cannot decide whom it waits for, and a decision
  by someone else shows their name instead of their account id. The member list is read only when
  the log names someone other than the viewer.
- f4726a6: One config form renderer for every extension config: deployment config, org extension settings,
  channel connections, the catalog install wizard and the plugin upgrade dialog. It draws the JSON
  Schema with its `x-ui` hints (labels, help, units, options, sections, the Advanced disclosure),
  arrays of objects as repeaters (endpoints with their models as compact rows, presets), records as
  key / value rows, secrets as keep / replace / clear (a key per endpoint for records drawn per item,
  saved through `secretEntries`, renames keep the key), unions as JSON. Server issues land on their
  field by `segments` (`messageKey` picks the localized hint message); a pending-config extension
  opens on its form with the missing fields listed. Replaces `SchemaForm`, the flat deployment form
  and the JSON stopgap for object-valued secrets.
  
  Design: `KeyValueEditor` takes `maskValues` (password value inputs, used for secret records), and
  after an add a `Repeater` focuses the new item's first empty required field.
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
- 212189a: Extension display names in the web: admin and org extension lists, the extension detail title and
  breadcrumb (the id is muted meta), the channel plugin picker, the models page and every model select
  read "OpenAI 兼容 / deepseek/deepseek-flash". The new check rule `web-ui-extension-label` forbids
  provider labels built by hand outside `lib/extension-label.ts`.
- 05cc5d7: The web image's health check asks `/healthz`, which the web server answers itself (no Next, no kernel), instead of `/login`, which now reads the kernel and redirects a fresh deployment to `/setup`. Creating the first agent from the setup layout lands on a new conversation with it again.
- e90e4c5: The UI language leaves the URL, language and theme are one click away, and the tab has an icon.
  
  - **Language in a cookie:** page URLs no longer start with `/zh` or `/en`. The language comes from
    the `NEXT_LOCALE` cookie, else the browser's Accept-Language, else Chinese, so the server renders
    the right language at once. An old link such as `/zh/agents` redirects (308) to `/agents` and keeps
    its language in the cookie. The web image's healthcheck now requests `/login`.
  - **Language and theme controls:** the sidebar's foot shows a language dropdown and a light / dark
    theme radio above the account (in the narrow rail they lead the account menu); the login, setup,
    invitation and binding pages show the same controls under their card.
  - **Tab icon:** the capybara mark, in each theme's accent color.
- 9c2a963: The page head shows a path line (scope / page / object) and optional tabs with a search; every page uses one content width.
- 657ddae: Acceptance round 2 of the web order: one designed empty state everywhere; marketplace entries as object rows; inbox pages show one empty state when nothing is pending; list heads keep their tabs and search while loading, and the tab underline sits on the row's border; the sidebar has search and the inbox as brand-row buttons and 更多 as a flyout menu; while an organization has no model or no agent the workspace shows a guided setup layout (by role) instead of the shell.
- f1fa0da: A new overview page. Day to day it shows what waits for you (tool approvals you can allow once in
  place, skill changes, catalog requests), the conversations to pick up (marked when one waits for
  you), the organization at a glance (agents, skills, connectors, members, available models, your
  role) and your most used agents with a Chat button. Until a model and an agent exist it shows the
  setup checklist instead, with what can wait (invite members, connect a channel, install plugins).
  The design system gains `ItemList`, `StepList` and `Grid columns="main-side"`.
- 75f4279: The web proxy renews an expired session on page requests (one refresh per token per process) and
  sends signed-out visitors to sign in, or to the setup wizard on a fresh deployment, before any page
  renders.
- 971deb5: Every run in a conversation ends with a run row: `运行 · <model> · <duration> · <tokens>` and its
  status mark, built from the event log alone. A finished run's row is one quiet collapsed line; a
  failed run's row opens on the error (a sentence in the reader's language, the raw kernel text
  behind 原始错误), Retry, 查看轨迹 for the roles that may read the trajectory and, for enterprise
  admins when the model service is misconfigured, 去配置模型服务. It replaces the stopped, failed and
  hook-denied dividers. The properties panel's Context section shows the last run.
- 9e17de5: The page head and the scrolling body reserve the same scrollbar gutter, so with classic scrollbars
  the title no longer sits a few pixels off the content column below it.
- df8f140: Add the server data layer for server-rendered pages: a server transport for `apiFetch` that forwards the session cookie and peer address, deduplicates reads per request and never mutates, the page helpers `read` / `optional`, the session gates `getSession` / `getShell` / `workspace` / `admin`, and `useLoad({ initial })` / `useServerState` for views seeded with server data.
- 8960a5d: A setup checklist instead of an empty composer, and a tidier account menu.
  
  - **New conversation before setup:** without a model or an agent, `/chat` shows what is missing as a
    checklist (set up a model, create an agent, start a conversation) with the way to fix each,
    instead of a composer full of placeholders. Enterprise admins get a button to the extensions;
    others are told an enterprise admin configures models.
  - **Account menu:** "Organization ▸" and "Language ▸" are submenus above sign-out; the theme switch
    sits right after the account in the sidebar's foot. Menus support submenus.
  - **Auth pages:** the language and theme controls are right-aligned under the card, each at its
    own width.
- d3d23ec: The admin console (overview, accounts, organizations, deployment settings, models, extensions and
  the extension wizard, the deployment catalog and its import and requests, marketplaces and their
  entries) is rendered on the server behind the enterprise-admin gate: pages paint complete with no
  browser read before the first paint. Enabling or configuring a model provider refreshes the
  workspace readiness, so returning to the home page shows the shell, not a stale setup frame.
- 51851f8: The home page, a new conversation (`/chat`), a conversation and the inbox are rendered on the
  server: they paint complete, with no loading state and no browser read before the first paint.
  A conversation opens its stream from the last event the server read.
- 2886ab9: Signing in, finishing the setup wizard and signing up or accepting through an invitation now load
  the next page as a new document (after telling the other tabs), so the new session's frame is
  rendered on the server; the submit button stays busy until the page is replaced.
- c25288f: Server-rendered pages, final fixes: the web proxy also renews a session whose access cookie is
  about to outlive its token (less than 30 s left), and a browser refresh that loses the race to the
  proxy (`auth.refresh_race`) retries its request with the winner's cookies instead of failing. The
  home page's inbox and conversations are secondary panels with their own error state, and when an
  org stops being ready while the ready shell is still shown, the home page re-reads the layout. After
  transferring ownership, owner-only member actions disappear at once. The client-side page gates
  (`AdminGate`, `RoleGate`, `OrgGate`, `RequireSession`) are removed; pages gate on the server.
- fff136a: The agent pages (the list, a new agent and an agent), the skill library (the list and a skill),
  the connector pages (the list, a connector and the install wizard, whose `?template=` item is read
  with the page), the org catalog (the list, an item and the install wizard) and the channel pages
  (the list, a new connection, whose `?agentId=&returnTo=` preset is read with the page, and a
  connection) are rendered on the server: they paint complete, with the agent form's models,
  connectors, skills, sub-agent options and channels, and no browser read before the first paint.
- 01f6fe3: The eval pages (sets, a new set, a set, the run wizard, a case's snapshot trajectory, a run with
  the first 200 results) are rendered on the server behind the org-admin gate; an active run keeps
  polling after the first paint and further result pages load with "Load more". The runs list reads
  its filters from the query (a filter change is a navigation) and its first page on the server; a
  trajectory reads its latest runs once on the server (each read is audited). An extension's org
  page reads its view on the server and keeps live refreshes after the first paint.
  
  The sign-in page takes `returnTo` and `error` from the query and its sign-in sources from the
  server, and sends a visitor who is already signed in on to `returnTo`; signing in, setting up and
  signing up through an invitation tell the other tabs. The invitation and binding pages read their
  token on the server (signed out, the binding page goes to sign-in before it renders).
- a1f534a: The organization settings (general, sandbox, members, models, plugins, extensions, service tokens)
  and the personal settings (connections, remembered approvals, identities) are rendered on the
  server: they paint complete, behind the same role gates, with no browser read before the first
  paint. A change re-renders the page on the server.
- 42dc31e: The signed-in frame is drawn on the server: the shell, the setup frame (with its steps in the
  sidebar) or the org chooser paints at once from the layout's data, with no loading frame. Org
  switches keep the current page until the new org's frame is ready, sessions follow sign-in, sign-out
  and org switches across tabs, and a starting kernel or a failed page retries by itself.
- fa34d48: Admin pages read cleaner. Models: model names keep a 240 px column, capabilities are plain text
  (「工具 · 缓存」) that wraps between items rather than being cut, the price columns are narrowed to their
  figures, and the purpose cards (in the admin console and in org settings) share one ActionRow that
  saves every changed purpose instead of a 保存 per card; choosing 未设置 / 使用部署默认 clears or restores.
  Marketplaces: a refresh error is one sentence in the reader's language with the raw text behind a
  原始错误 toggle; the status label sits above its value; every switch is labelled; the Browse and
  Sources tabs share one head (description, tab counts, search), so the tabs never move, and the
  empty entries list points to 市场源. Extensions: the detail page's 升级 is a button, the bootstrap note
  says the plugin comes from npm with its version and checksum pinned, and list rows read 「副本一致 2/2」.
- d8810dd: Colour follows four roles: orange for the primary action, focus and the current location, yellow
  for what needs attention, red for failure, green for ok. A checked option card, the command
  palette's current row and the trace's selected row use a neutral selected ground with a strong
  border (the radio dot and the focus ring stay orange). An empty list shows one primary: the page
  head's primary hides while the empty state carries it. 「敏感」 is one yellow word everywhere (no box),
  the permission groups are ordinary hairline cards, and 企业管理员 in the accounts list is plain text. A
  failed run reads red in the status bar. In the dark theme, path segments and key labels are muted
  (no longer faint), disabled controls reach 3:1 with a visible border, cards get a hairline and
  scrollbars a quiet thumb. The sign-in dither is greyscale.
  Only the 「敏感」 word is yellow: the reasons and items of a sensitive permission group read as
  ordinary text, and the org extension page shows 必需 as muted text and 不可用 as attention text
  instead of orange badges.
- 322df8f: Copy sweep: one name per action and object (新建, 重命名, 会话, 子 agent, 首页, 创建时间), empty-state sentences end with a period, the home page is titled with its page name, the trajectory run detail shows the starter's name, and an empty `/` menu says the agent has no skills to run.
- 4f28d0b: Type, figures and details read as one system.
  
  - Sentences (hints, notes, descriptions, dialog bodies, field help, empty states) are set in the
    prose font; mono stays for ids, paths, numbers, versions and dates.
  - One date format: `YYYY-MM-DD HH:mm` in mono with the relative age on hover (`MM-DD HH:mm` in the
    sidebar's dense list); versions always read `v0.1.0`.
  - The home figures and an extension's facts are two label/value columns 32 px apart; the action
    row ends where the content ends.
  - Menus keep 8 px from the window's edges and are as wide as their trigger; the current
    organization reads as the current choice, not as disabled; the 更多 flyout shows the nav icons.
  - Avatar tiles are the upper-cased first letter of the name everywhere, extensions included;
    visibility and model purpose ids are plain muted text, not badges.
  - Empty states have two styles: the line-art capybara on a page, the sentence alone in tables,
    cards and panels.
  - On phones the settings sub-nav is one scrolling row above the content; the deployment's org
    limits note is one paragraph.
- a194dd1: Tables keep their meaning on phones: every table element carries its role, the column headers
  stay for screen readers, and a compact bar above the stacked rows offers 全选 and a 排序 select.
  An agent row offers 编辑 once (its name) and 开始会话; admins see 更换负责人 as a button. The
  error page's path links only the segments that are pages, the phone settings row keeps its focus
  ring inside, a sub-agent conversation's run rows don't link a trajectory, and the eval case page
  names the run's starter (the account id in a tooltip). 「已覆盖」 is muted text, token counts read
  「{n} token」.
- 39017d5: Forms and flows: 新建渠道 without a channel extension shows only the empty state; create forms and
  dialogs start on their first field, keep the primary disabled until valid and never say 没有未保存的修改;
  加入评测集 with no eval set offers 新建评测集; the only owner's 退出组织 dialog is a plain 知道了;
  dangerous dialogs are red only on their destructive button; install and import flows use card
  radios and the new FilePicker drop zone; the org danger zone sits in the form column.
- afadd4e: Phones (below 640): nothing runs past the window's right edge any more. The conversation page
  drops its minimum width and uses 16 px gutters, so the composer, its send button and the user
  bubbles fit; tabs stay on one line and scroll sideways, and the page head's search takes its own
  line; every table becomes stacked rows (the first column as the title, then label · value lines);
  stat cards are two columns; page-head actions and tabs, row actions, the drawer bar's and the
  conversation title bar's buttons are 40 px tap targets, and so are the sidebar drawer's rows.
- 8250abd: Polish the web UI: consistent copy (lowercase "agent", "新建", sentence periods), a calmer type
  scale and buttons, metadata as text instead of badges, linked admin metrics, a simpler setup home,
  centered table empty states, and the `i18n-label-period` check.
- b904bb2: The conversation title bar's buttons open the panel they name: Files appears once the conversation
  has a file and opens it, More appears only when two or more icons don't fit. No overflow menu holds
  a single action any more (it is drawn directly) and no menu repeats a visible action. The status
  bar signs every page `<login>@<org slug>:~/<path>` (`/admin/<path>` in the admin console), the
  conversation page included, with the time zone; error and not-found pages keep the page's path in
  their head, and the title-bar path is spaced like the page head's.
- 6dfb4ee: One page width everywhere: every template, the inbox, trace, onboarding and status pages included,
  is capped at the content width with the same side padding, so the page head sits at the same place
  on every page and tab. The trajectory detail follows the waterfall (a right panel from 1280), the
  members page uses the settings frame with its sub-nav, and a settings page's description opens the
  content column so the sub-nav never moves.
- Updated dependencies [15af7fd]
  - @capybara-hq/design@0.1.1-rc.0

## 0.1.0-rc.3

### Minor Changes

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
- 56e83dd: A tool call logged under a release-candidate builtin key (`sandbox_bash`, `skill_load`, ...) that was
  still open when the tool names changed runs as the renamed tool with its parameters translated, and
  its result keeps the logged key. An approval of such a call given after the upgrade lets it run
  without asking again, and an `agent` call whose sub-agent was dispatched before the upgrade gets its
  result when the sub-agent finishes. A call to an old key that the request never offered gets the
  unknown-tool error plus a hint naming the new tool and its parameters.
  `GET …/conversations/:id/tools` answers an old builtin key as its current tool with `aliasOf`, so
  the conversation page shows old `agent` calls as sub-agent rows and old builtin calls with their
  current label.

## 0.1.0-rc.2

No changes in this release.

## 0.1.0-rc.1

No changes in this release.
