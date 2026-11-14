# @capybara-hq/capybara

## 0.1.0-rc.31

### Patch Changes

- 42ed68e: Bootstrap pins move to the plugin versions the official marketplace lists at capybara-hq/plugins
  ce9c71ed, the release that ships the auto-mode sandbox network policy (openai-compatible rc.10,
  object-store-s3 rc.9, sandbox-docker rc.14, skills-core rc.1, the rest likewise). The compose
  sandbox build contexts point at the same commit.
- 73afa8f: The device page is one head and two views: its name band is the page's head (a new `DetailPage`
  form, `header.titleHidden`) with the 概览 / 设置 tab row under it, 概览 shows values only (network
  hosts, resources, the machine's system, files, recent changes) and 设置 holds every control as
  settings sections — the run mode as card radios with one consequence each, the network allowlist
  with an add dialog, disconnect, and a danger zone for delete. The page's one-off mode scale is gone,
  and the sandbox mode reason reads as a statement instead of repeating the mode it already shows.
- Updated dependencies [42ed68e]
- Updated dependencies [5e232e6]
  - @capybara-hq/kernel@0.1.0-rc.30

## 0.1.0-rc.30

### Minor Changes

- 059fa71: Agent-created git commits and pull requests now carry a configurable attribution line. The
  deployment defaults live in the startup config `attribution` (commit, pr, sessionUrl) and in the
  admin console's settings; an agent's definition may follow them, use its own values or turn
  attribution off. The effective values are recorded at run start in the conversation's run context,
  so replay reproduces the instruction exactly; the kernel instructs the model and never rewrites git
  history.
- caa4575: Auto mode: a device runs in `auto` (commands with the environment's own capability, guarded by
  command review) or `sandbox`. The platform's `devices.autoMode` switch and the org's `autoMode` and
  `cloudNetwork` settings replace the sandbox tiers and the org egress setting; `/admin/settings`
  shows the platform's switch with where it comes from, `/settings/sandbox` holds the org's auto mode
  and the cloud devices' sandbox-mode network, and a device page shows its mode, the 自动 / 沙箱
  switch and its network (sandbox mode only). A command the review holds appears as its own approval
  card in the conversation and in the inbox.
  
  Migration 0130 drops `devices.tier` and the `sandboxTiers` setting, so this is not a rolling update:
  on a deployment with more than one replica, drain or stop the old `api`, `worker`, `gateway` and
  `web` replicas before running `capybara migrate`.

### Patch Changes

- Updated dependencies [059fa71]
- Updated dependencies [caa4575]
  - @capybara-hq/kernel@0.1.0-rc.29

## 0.1.0-rc.29

### Patch Changes

- 87f0426: Turning a plugin back on no longer asks for the input of a connector template whose connector an
  earlier switch-off kept: the org item detail marks such a template `connected` and the enable wizard
  skips its step, saying the existing connector is kept (the install reuses it unchanged); an install
  whose kept connector is deleted between planning and running now fails with
  `catalog.connector_removed` (retry it) instead of finishing without a connector.
- 3414c94: Switching a plugin off now switches off the connectors recorded on its install (migration 0129 adds
  `connectors.disabled_by_plugin_id`): their endpoint and credentials stay, their tools stop being
  offered, and the switch-off preview lists them as disabled with the plugin instead of kept on.
  Switching the plugin back on reuses those connectors and switches them back on, except one an org
  admin disabled by hand; deleting a connector stays possible and permanent, and a failed install's
  rollback still deletes the connectors it created.
- 59f82a3: The api role serves the git gateway `GET` / `POST /git/v1/<host>/<owner>/<repo>/…`: git smart-HTTP
  for sandboxes, authenticated by a run ticket (`Authorization: Bearer`), relayed to the host with the
  actor's connector credential (re-resolved per request), streamed both ways with no redirects, only
  the spec's headers, a byte cap per run, a per-org concurrency cap and an idle timeout. Pushes follow
  the `git_push` policy before any byte reaches the host; a held or refused push is answered in git's
  own protocol (`remote: Capybara: …`) and recorded for the exec.
- 233af93: Git pushes through the gateway follow a per-connector policy `git_push` (default ask, migration
  0127 `connectors.git_push_policy`). An ask is an approval of kind `git` (`approval_requested.git`,
  display only): 「这次允许」 is a run grant, 「这个仓库一直允许」 the member's
  `git_push:<host>/<owner>/<repo>` allow. Scheduled tasks accept `git:push` and
  `git:push:<owner>/<repo>` grants; an unattended run without one is refused and records the missing
  grant.
- 907f908: Connectors carry a git source: the create body accepts `git` (the SDK's `GitSourceSchema`), a
  template's `git` is stored at install and on template updates (`connectors.git_hosts`), and an org
  admin can turn on `useForGit` for an org-credential connector. `GitSources.sourcesFor` picks one
  connector per git host for an actor (own personal credential, org connectors only with
  `useForGit`, the org's `gitGateway.hostSources` pick, else OAuth, else the oldest; nothing for
  anonymous guests). `Credentials.gitAuthorization` builds the Basic value inside `Credentials`;
  `GitIdentities` reads the GitHub name and noreply address once (cached 24 h). An invalid stored
  `gitGateway` org setting now reads as off.
- f453e56: Scheduled-task tools can deliver to an IM chat: `ScheduleCreate` / `ScheduleUpdate` take
  `mode: "chat"` with `chat { connectionId, chatId, chatType?, agentId? }` (the chat's agent is
  nested, defaulting to the run's agent), and the new `ScheduleTargets` tool lists the chats the
  caller can deliver to (the same data as `schedules.chat-targets`). A chat whose channel extension
  is disabled in the org is no longer offered or accepted at create or update, and a run skipped for
  it records `plugin_disabled` instead of `target_gone`.
- Updated dependencies [87f0426]
- Updated dependencies [3414c94]
- Updated dependencies [59f82a3]
- Updated dependencies [233af93]
- Updated dependencies [907f908]
- Updated dependencies [f453e56]
  - @capybara-hq/kernel@0.1.0-rc.28

## 0.1.0-rc.28

### Patch Changes

- 188af9d: A confirmed plugin import stops reading the staging it consumed (the error card that flashed before
  the navigation landed); an extension component asks for its view after mount, not from its render;
  extension pages draw no single-tab bar; the client API forwards the design system's `Select`, so a
  client component offers a plugin's choices in the product's own dropdown rather than the browser's;
  switching a plugin back on takes back the connector an earlier switch-off kept for agents instead
  of creating a second one (which failed on the slug); a connector slug may equal an installed
  extension's name (their tool keys stay apart, `mcp__` against `plugin__`), so a template whose
  default slug is its plugin's name (slack, github) configures as it is; a default-off connector
  template an admin switched on in the org asks for its input at install, as the install is what
  creates its connector (before, the wizard hid the fields and the install refused).
- Updated dependencies [188af9d]
  - @capybara-hq/kernel@0.1.0-rc.27

## 0.1.0-rc.27

### Patch Changes

- 8770eeb: The scheduled tasks page opens on the calendar: 日历 is the first tab and the default (`/schedules`), the list moves to `?view=list`; a remembered choice still wins.
- 47ef322: A person's stop of a conversation now stops every running sub-agent below it too, and the
  conversation stays stopped: no sub-agent finish or report starts it again until the next message,
  whose run sees what they delivered. The conversation's own background Bash tasks keep running.
- b6b8d13: TaskOutput given a sub-agent's agentId answers where its report arrives instead of failing the call; TaskStop still refuses it.
- 3c7c8bf: Device policy changes record their intent before the call. Before a `policy` op is sent, one
  transaction writes the op on the machine's row (who asked, for which network ask), audits
  `device.policy_requested` and owes a `device-op-resolve` job for when the op can no longer reach the
  machine; the outcome is recorded after the call: `device.policy_changed` when applied,
  `device.policy_failed` when refused or never received, `device.policy_unknown` when no answer came.
  A crash between the call and the record no longer leaves a changed device without an audit: the
  job asks the machine what became of the op (`policyStatus`, never sending the change again), and
  a machine that is offline reports it in its next hello (`recentOps`), recorded late. Policy changes
  now need a `capybara-device` that announces `policyOpId`; an older one is told to update.
  `device.policy_changed` no longer carries `confirmed`.
  
  Network asks decide on that intent. 「这台设备一直允许」 records the intent (naming the ask) before
  the device is called, and the ask's decision and the op's outcome are written in one transaction;
  a change applied after the ask closed is audited `device.network_allowed` with `late: true` in that
  same transaction. When the process stops between the call and the record, the resolve job approves
  the still-pending ask (`always`, by the person who chose it) and resumes its run if the device
  applied the change; otherwise the ask stays pending with the reason (`detail.attempt`, an
  `approval_updated` event) and the card says why. A device is asked only when its program announces
  `policyOpId`. The device page lists changes the machine did not confirm or that did not take
  effect (the view's `confirmed` is replaced by `outcome`).
- bb931fd: Transactional outbox follow-ups. Retrying a dead outbox row that is owed again twice while it is
  retried answers 409 `conflict` instead of an internal error, and its audit detail always names the
  row's own queue and job. A run job that read a run as queued before a stop ended it records no
  skills catalog or run context for it. Allowing hosts always on a device no longer reports success
  when the request was approved meanwhile with other hosts and the device did not confirm this
  change. On the admin overview, a dead outbox list that cannot be read shows the group's
  unavailable state with retry instead of a bare count.
  A stop that lands while the context providers are asked appends no plugin context after the run
  ended; a deleted org's runs are no "queue lost jobs" report and its usage is still reported; a
  worker fails a maintenance job it does not know so a newer replica retries it.
- Updated dependencies [76828c0]
- Updated dependencies [47ef322]
- Updated dependencies [b6b8d13]
- Updated dependencies [a9f726b]
- Updated dependencies [3c7c8bf]
- Updated dependencies [bb931fd]
  - @capybara-hq/kernel@0.1.0-rc.26

## 0.1.0-rc.26

### Patch Changes

- b177905: The compose files and test containers run PostgreSQL 17 with pgvector (`pgvector/pgvector:pg17`),
  and migration 0123 creates the `vector` extension in `public` when the server offers it and the
  migrating role may create it; otherwise it only raises a notice, and plugins fall back to `real[]`.
  `@capybara-hq/testing` exports `startPostgresContainer` (with an `image` option) and `TEST_PG_IMAGE`.
- Updated dependencies [fc46148]
- Updated dependencies [23c16d8]
- Updated dependencies [b7e70f7]
- Updated dependencies [b177905]
- Updated dependencies [fcfabb4]
- Updated dependencies [b4d2b44]
- Updated dependencies [240801c]
  - @capybara-hq/kernel@0.1.0-rc.25

## 0.1.0-rc.25

### Patch Changes

- 4807c1f: The `Bash` description tells the model that tools ignoring HTTP(S)_PROXY, such as browsers, need
  the proxy passed explicitly (Chromium: `--proxy-server=$HTTPS_PROXY`).
- ba36733: A device's recent sandbox changes now list the policy changes its owner makes on the machine
  (`capybara-device policy ...`: tier from and to, localhost, allowed domains added and removed,
  isolation, remote grants) as 本机 beside the web's, each change once.
- 67e6ad5: A local OS-sandboxed device now kills what a foreground command leaves running (`server &`,
  `nohup …`) when the command ends, by its process group and by a per-command marker for processes
  that left the group. Inside the sandbox no later command could signal them, so they leaked. A
  background task launch, whose command starts with the new `BACKGROUND_LAUNCH_LINE`
  (`@capybara-hq/plugin-sdk`), keeps what it starts. The `Bash` description tells the model to use
  `run_in_background` for servers and watchers.
- 916b1d0: An extension's properties section whose schema view has nothing to show (no blocks, or only empty
  lists) is no longer drawn: no header, badge or empty state until it has content (the todo
  section before the agent's first to-do), and no skeleton during its first load.
  
  The bootstrap `todo` plugin moves to 0.1.0-rc.8 (the plugins marketplace at 4bfd588): the list is
  titled 「待办」 / "Todos" and its properties section stays hidden until the first to-do.
- 9370947: Updating an installed platform plugin to a newer version is one wizard: 更新到 vX on the admin
  plugin list, the plugin's page and the marketplace tab stages the version and shows the import
  review, then the platform update preview; one confirm applies both (`GET
  /api/v1/admin/catalog/imports/:stagingId/update-preview`, `POST …/imports/:stagingId/update`).
  Cancelling writes nothing; an update failing after the import says so (409
  `plugin.imported_not_updated`) and leaves the platform on its version. An installed plugin is no
  longer imported on its own; the 版本 tab moves the platform to another imported version (更新到 /
  回退到). A plugin not installed yet shows 安装 instead of 导入 / 引入.
- 73c1232: Org-side plugin wording follows install/update: 申请安装, 已安装, 不能安装; the audit reads 安装了插件.
- 3a884eb: A cloud sandbox provider that refuses a device's tier (for example sandbox-docker or sandbox-e2b with
  `openEgress: "off"` at the open tier) now gives the model an actionable tool error
  (`sandbox.tier_refused`) instead of a generic failure; any other failed create is
  `sandbox.create_failed`. TaskOutput and TaskStop called with a sub-agent's agentId say that its
  report arrives as a notification, so the model stops polling for it.
  
  The bootstrap plugins move to the plugins marketplace at 3750cf7: sandbox-docker 0.1.0-rc.12 (sandbox
  tiers, `openEgress` defaulting to `proxy`; rc.10 refused the open tier by default), and the other
  pins to the versions built on plugin-sdk rc.17. The compose sandbox image contexts follow the commit.
- 46fda48: A scheduled task calendar read: `GET /api/v1/orgs/:orgId/schedules/calendar` (and the Platform
  operation `schedules.calendar`) returns a range's recorded runs and the planned occurrences the
  scheduler will fire, from its own ticker, with dense task-days summarized per day.
- 42b1637: The scheduled tasks calendar on `/schedules`: 列表 / 日历 tabs in the page head (remembered per
  browser), a week and a month of recorded and planned runs, dense tasks collapsed per day, the run
  panel (from the address hash) with the run, its conversation and the task, the admin 全组织 scope
  and the phone's agenda.
- e2731bd: New builtin tool `TaskList`, offered with `Bash` like `TaskOutput` and `TaskStop`: it lists the
  conversation's own background tasks (running first, then the 20 most recently finished, with id,
  description, status, elapsed time, exit code and output file) and the sub-agents it dispatched.
  Read-only and allowed by default; `status: "running"` lists only what still runs. `TaskOutput`'s
  not-found error and the `Bash` description point to it.
- c619811: A transactional outbox: work that must follow a commit is a row in `capybara.outbox` written in the
  same transaction (`OutboxService.add`), delivered right after the commit by a fast path and, when
  that fails, by a relay on the worker role every 2 s; failures back off and after 20 attempts the
  row is a dead letter the super admin sees in the overview (无法排入队列的后台任务) and can retry or
  discard (`/api/v1/admin/outbox/dead`, Platform operations). New checks `kc-enqueue-via-outbox`,
  `kc-after-commit-hint` and `check:outbox-registry` (migration 0119).
- 86c258c: Agent runs have no step limit and no duration limit by default: `runtime.maxSteps` and
  `runtime.maxRunSeconds` default to 0 (no limit), so a run goes on until the model stops calling
  tools or someone stops it. Without a run duration limit, sandbox commands are limited only by
  `sandbox.limits.maxCommandSeconds` and the tool timeouts; explicit positive limits work as before.
- Updated dependencies [ba36733]
- Updated dependencies [9370947]
- Updated dependencies [e2731bd]
- Updated dependencies [c619811]
- Updated dependencies [b8a3c5b]
- Updated dependencies [36d904d]
- Updated dependencies [86c258c]
  - @capybara-hq/kernel@0.1.0-rc.24

## 0.1.0-rc.24

### Patch Changes

- 8471657: A local policy change made on the machine (`capybara-device policy ...` while the service runs, a
  flipped localhost proxy guard, a new tier ceiling) reaches the deployment at once: the device
  pushes its new summary in a `policy` frame (new in the device protocol), and the kernel stores it
  as it stores the hello's, so the device page and the next `device_paths` line show it.
- 8ef7ec6: The plugin enable wizard no longer asks for connector templates that start switched off
  (`defaultEnabled: false`); the org catalog detail marks them with `defaultOff`.
- f156a46: Background Bash tasks (`run_in_background`) work on macOS devices: where `pgrep` has no `-s`, the
  launch runs the command in a process group of its own, watched by a small perl launcher that
  enforces the time limit and signals the group on a stop (macOS has no `setsid` or GNU `timeout`,
  and its OS sandbox lets no command list or signal another command's processes).
- a3ca5ef: The super admin sets the platform's sandbox levels (`sandbox.tiers.max`, `default`,
  `allowUnsandboxed`) on the admin settings page (`PUT /api/v1/admin/settings` `sandboxTiers`). A field
  set in the startup config (env, file or Nacos) wins and is read-only there; an API token or the
  Platform tool may only lower them. The dev hosts preset (`DEV_HOSTS`) adds `storage.googleapis.com`,
  where Playwright's Chromium download (Chrome for Testing) is served from.
- Updated dependencies [8471657]
- Updated dependencies [8ef7ec6]
- Updated dependencies [f156a46]
- Updated dependencies [a3ca5ef]
  - @capybara-hq/kernel@0.1.0-rc.23

## 0.1.0-rc.23

### Minor Changes

- 67b39b3: The device owner edits a connected device's network policy from the web:
  `POST /api/v1/orgs/:orgId/devices/:id/policy` (`add`, wildcards allowed; `remove`; `network`
  `allowlist` or `open`), web session only, delivered with the `policy` device operation. Widening
  needs the device's local `remoteGrants: "owner"` (else 409 `device.policy_refused` with the command
  to run on the machine). The device view lists the last ten policy changes (`network.recent`).
- e964b57: Network asks: when a command on a connected device is refused a domain by the device's local
  policy, the device owner is asked in the conversation or on the IM card (「这次允许 / 这台设备一直允许 /
  拒绝」). "This time" allows the domain for the rest of the run tree; "always" adds it to the device's
  local policy through the new `policy` device operation. Org-layer and address-layer refusals are
  explained to the model and shown under the command. Migration 0114 adds approval kinds and device
  policy summaries.
- 9725087: A character budget for the skills catalog: `skills.catalogBudgetChars` (hot, default 16000). At run
  start the catalog's entries are ranked (the agent's own and the ones it shared, builtin, the organization's own, then
  plugin skills) and those past the budget are recorded in the snapshot as name-only and listed
  after the others under "More skills (names only; …)". Old snapshots render as before.
- e808481: Skills are on by default in the web app: the agent page's 技能 section lists every skill on in the
  org checked, and unticking one turns it off (`disabledSkills`); a plugin's group head turns the
  whole plugin off, its later skills too. Pinning is gone (the 置顶 section, the pinned suggestions
  of plugin import, the token estimates). The agent template editor edits `disallowedSkills` with the
  same list and the skills a sub-agent loads first. The org 技能 page filters by plugin and its
  detail says how many agents turned a skill off (`agentsOff` on the skill detail); switching off a
  plugin with skills says every agent loses them; the admin agent pages show the off count.
- 95fc4b0: Skills are on by default and pinning is gone. Every skill on in an org is on for every agent unless
  the agent's new `disabledSkills` turns it off (a plugin's skills by name, a whole plugin as `"all"`
  including skills it gains later, or a skill without a plugin by id); builtin skills, the agent's
  own and its shared skills cannot be turned off. `skills.orgSkills` and `skills.pinned` are removed
  from the agent definition (refused on save; migration 0116 rewrites every agent version), run start
  no longer injects pinned skill bodies (an old conversation gets a "Pinned skills removed" notice),
  and `agent.pinned_invalid` is gone. A sub-agent template's `skills` become one logged line telling
  the child to load them with `Skill` first. `plugin.json` `skills[].pinned` and the import confirm's
  `pinnedSuggestions` are removed; the skill APIs drop `suggestPinned`, `entryBytes` and
  `tokenEstimate` and the library list gains `builtin`; the Claude Code import reports a
  `session_start_hook` warning instead of a pin hint. The Platform tool's `agents.create` /
  `agents.update` take `disabledSkills`, and `platform.me` lists the agent's skills.

### Patch Changes

- 0f8f5bb: The agent page's 组织技能 and the agent template's 技能 group the skills by where they come from
  (each plugin, the org's own, the built-in ones), each group with a select-all box (checked/total,
  mixed) and a filter for long lists; each row is the name and its badges on one line and the
  description cut to one muted line with the full text on hover (new design `CheckList`). A badge
  never shrinks or wraps, and a checked disabled checkbox keeps its check visible.
- 89a0a5c: The `Bash` tool description tells the model that network access goes through a proxy and that a
  blocked domain is reported after the command output.
- 105a59e: The skills of builtin plugins on in the org (`skills-core`'s `skill-guide`) are in every agent's
  skills catalog without being selected (listed, not pinned; an agent's own skill of the same name
  wins); the skill library marks them `builtin`, and the agent page shows them ticked and disabled
  with a "Built-in" tag
- f6d6f16: The `capybara:oauth-token-endpoint` setup check reads GitHub's token endpoint answers
  (`bad_verification_code` accepted, `incorrect_client_credentials` refused), and its fix text no
  longer names Slack's "Basic Information" page.
- bb3d177: Sandbox tiers in the kernel: cloud devices get their effective tier (applied on use through the provider's `update`, or by recreating the instance on the kept files), local devices get the org's ceiling with every command, scheduled runs need the `tier:open` task grant for the open tier, and a device running without a sandbox is refused where the org does not allow it
- c36ce32: Scheduled tasks: cron-triggered agent runs into a new conversation, a chosen one or an IM chat, with task grants, trial runs and pause on lasting failures
- bfb35e3: Tool rows no longer read a Bash command's non-zero exit as a failure (only a timeout or a stopped
  command fails; the summary names the exit code), and an `Edit` / `Write` refused by the
  read-before-write check carries the display-only `tool_result.view.kind: "guard"`, shown as
  "Blocked: read the file (again) first" and counted apart from failures; the model still gets the
  same error result
- f274ba6: Sandbox levels in the web app: the device page has a 沙箱级别 section (strict / development / open
  cards, follow the org default, capped cards, the effective level, the machine's development facts,
  the local commands for running without a sandbox and 恢复沙箱), device cards and the composer's
  device picker mark 开放 and 不使用沙箱 devices, and the org sandbox settings choose the highest
  level, the default for new devices and whether members' devices may run without a sandbox, with
  the development hosts listed under the allowlist.
- Updated dependencies [2682d5f]
- Updated dependencies [89a0a5c]
- Updated dependencies [105a59e]
- Updated dependencies [67b39b3]
- Updated dependencies [f6d6f16]
- Updated dependencies [bb3d177]
- Updated dependencies [e964b57]
- Updated dependencies [c36ce32]
- Updated dependencies [9725087]
- Updated dependencies [e808481]
- Updated dependencies [95fc4b0]
- Updated dependencies [f1331fe]
- Updated dependencies [bfb35e3]
  - @capybara-hq/kernel@0.1.0-rc.22

## 0.1.0-rc.22

### Minor Changes

- ac35f95: Bootstrap manifest entries may be `builtin: true`: builtin in the catalog, imported after the
  extensions load (so they may ship skills), and a failure does not stop the start

### Patch Changes

- c371130: Bootstrap pins the builtin `skills-core` plugin (skill-guide); compose's init waits for the
  object store, where the bootstrap's second pass stores its skills
- 6d9e768: Bootstrap pins move to the plugin versions the official marketplace lists at capybara-hq/plugins
  14c73d5 (openai-compatible rc.7, object-store-s3 rc.6, sandbox-docker rc.10, the rest likewise)
- Updated dependencies [ac35f95]
- Updated dependencies [c371130]
- Updated dependencies [6d9e768]
  - @capybara-hq/kernel@0.1.0-rc.21

## 0.1.0-rc.21

### Minor Changes

- fc9cbe6: Agents author skills with files and the Platform tool; SkillWrite removed

### Patch Changes

- cabf521: Acceptance fixes in the web app: one button per connector card and personal connections as cards;
  the member 权限 sheet and the connector tools tab list one row per tool by title, grouped read-only
  / may write; one connect card per connector in a conversation; the admin item opens 凭据 with the
  OAuth redirect URL; extension UI placement moved to 组织设置 › 外观; invitation links without a
  language prefix; the path's `account` leads to preferences; the platform update preview labels
  theme components; a DangerZone after settings sections spans their width; the admin health block
  shows the product and the kernel version.
- 0d0e6fa: Super admin pages for every org's agents and connectors
- 8f3f685: Admin overview health for super admins: every kernel process now reports its presence (roles,
  version, start time) in Redis every 15 s, and the new `GET /admin/overview/health` (with the
  read-only Platform operation `admin.health`) answers the live replicas by role, the kernel queue
  counts with failures in the last 24 hours, and channel, device and sandbox counts
- 3c16bf9: Admin overview reads for super admins: `GET /admin/overview` now answers
  `{ orgs, accounts, attentionTotal }`, `GET /admin/inbox` adds `byType`, and the new
  `GET /admin/overview/attention` and `GET /admin/audit` (platform-level audit log, migration 0109)
  come with the read-only Platform operations `admin.attention` and `admin.audit`
- 38e6432: Admin overview usage for super admins: the new `GET /admin/overview/usage?tz=` (with the read-only
  Platform operation `admin.usage`) answers runs, tokens and estimated cost per calendar day in the
  reader's zone over the last 7 days, and the 10 orgs that used the most tokens; cached 300 s for
  every replica, 503 `admin.usage_unavailable` when the database takes over 10 s. Migration 0110
  builds two plain indexes (`runs (created_at)`, `model_usage (occurred_at)`): on a large `runs`
  table, writes to it wait while the index builds
- 2b8bdfe: Background task output says why it cannot be read live (`unavailable` / 409 `details`: starting,
  not started, device offline, suspended, rebuilt, output missing, no access), naming the device or
  the sandbox; the panel never draws an empty output box; "N completed" opens the list of finished
  tasks; the right panel's full screen maximises it inside the page instead of the browser.
- 86d9528: The org extension tools list answers an empty list for an extension that runs but registers no
  tools (a channel, a model provider) instead of 404, so its settings no longer show 「无法读取工具」.
- Updated dependencies [0d0e6fa]
- Updated dependencies [8f3f685]
- Updated dependencies [3c16bf9]
- Updated dependencies [38e6432]
- Updated dependencies [2b8bdfe]
- Updated dependencies [86d9528]
- Updated dependencies [3756b00]
- Updated dependencies [fc9cbe6]
  - @capybara-hq/kernel@0.1.0-rc.20

## 0.1.0-rc.20

### Patch Changes

- b4816fc: Component lists and details carry `descriptionZh` (a theme's or skill's `description.zh`), and the
  web shows a theme's, skill's or agent template's description in the UI language (the org 外观
  page, the admin component cards and details).
- Updated dependencies [b4816fc]
  - @capybara-hq/kernel@0.1.0-rc.19

## 0.1.0-rc.19

### Patch Changes

- Updated dependencies [a49c72e]
  - @capybara-hq/kernel@0.1.0-rc.18

## 0.1.0-rc.18

### Patch Changes

- fa555e9: A message from the run's starter skips the run's pending questions: the question becomes `skipped`
  (migration 0108), `question_answered` carries `outcome: "skipped"` and `skippedBySeq`, the run
  resumes at once and the kernel writes a fixed result (the tool is not called again; MCP elicitation
  and extension input requests too); the message follows as an ordinary user message. Every question
  write locks the conversation row first. IM question cards carry `textReply` (`plain` in a DM,
  `mention` in a group thread) and the `skipped` state; trajectories show the skip.
- Updated dependencies [fa555e9]
  - @capybara-hq/kernel@0.1.0-rc.17

## 0.1.0-rc.17

### Patch Changes

- bae65fe: Channel connections choose their inbound mode when they are created. The config UI hint
  `inboundModes` (connection level, top-level fields) ties a field to inbound modes: forms draw it
  only in those modes and require it there, and the kernel refuses a create, config change or mode
  switch that leaves a required field empty (`extension.config_invalid`). `inboundModeFields` and
  `missingInboundModeFields` read the hint. `POST /channels` takes `inboundMode`;
  `GET /channels/schema/:plugin` says whether webhook inbound is usable (`inbound`). A connection name
  nobody typed yet is reported unresolved as `no_name`. The fake-im fixture's `webhookToken` is
  webhook-only. 新建渠道 sends the guide's mode, follows it with the credential fields, and shows
  less noise before save.
- Updated dependencies [bae65fe]
- Updated dependencies [0be1551]
  - @capybara-hq/kernel@0.1.0-rc.16

## 0.1.0-rc.16

### Patch Changes

- 99a970a: `IconButton` carries the `button` UI part (`button button.primary` for the primary variant) like
  `Button`, so plugin CSS on `[data-cap-part~="button"]` reaches every button, the composer's send and
  stop among them.
- 90e6e18: `AppShell` (and `SetupPage`) take a `banner`: a shell-wide row (safe mode's `SafeModeBanner`) drawn
  as the shell's first grid row across the sidebar and the content column, which share the rest of
  the window. In safe mode the web draws its banner there instead of above the 100dvh shell, so the
  status bar and the bottom of the page are no longer clipped.
- 56fc173: A plugin whose client code was built for a newer client API than the kernel's `CLIENT_API_VERSION`
  is refused at import with `client.api_unsupported` (400), and the client shell reads never list a
  build of a client API version the web host does not run.
- b270b7e: Client component pages (`org.page`, `platform.page`) and agent sections (`agent.detail.section`)
  always draw their body with designed states: loading while the module loads, the failure line
  (retry reloads the page) after a failed load, and "not available" when the code is off (safe mode,
  the kill switch, a spent crash budget, a withdrawn plugin). Their nav entries (the sidebar's
  extension pages, the agent page's sections, the admin console's platform pages) are not offered
  while the code is off.
- fc0213c: Client components render in the web. In list slots a `component` contribution renders in the same
  place as a view (its slot's frame, anchors unchanged) once its module is registered, inside the
  block's error boundary (a crash shows the failure line and is reported once and counted against the
  plugin's crash budget), with the host context the plugin-client hooks read (`useView` reads the
  component's server view with the slot's args only when asked). A component's right panel always
  has its frame (title, close) with a loading or failure state; component panels are not offered in
  safe mode or under the kill switch. The replaceable slots `shell.brand`, `conversation.empty` and
  `conversation.composer.frame` render the kernel's winner or the built-in: the built-in in safe
  mode, under the kill switch, and when the winner fails to load, throws or (composer frame) leaves
  the composer's textarea out of its slot, also on its own re-render; while the winner loads the
  built-in stays hidden for at most 1.5 s. A composer frame gets the framed composer as `builtin` and
  its bare inputs as `children`. When the org's client set has a component for one of these slots,
  the layout's shell read also prefetches the contributions, so the server renders the slot pending
  (the frame's CSS reveals the built-in after 1.5 s) and a winner renders without a read.
  `shell.overlay` renders in the decoration layer once one of its components is ready. The admin
  console renders neither the overlay nor replacements.
- 1bac942: Client host fixes: a layout refresh no longer remounts the page after a client navigation from a
  workspace page without client code into the admin console. A contribution's crash counts
  once per document toward the crash budget, however many places draw it. A router push or Back
  across the client-code boundary turns the old scope's plugin code off before the document load. A composer frame must render
  the composer exactly once (two copies fall back to the built-in). The safe-mode cookie is
  HttpOnly; the banner's exit loads the page with `?safe-ui=0`, which clears it. The admin extension detail's
  client reports name the org (a deleted org says so) instead of its id. A focus request the composer
  cannot take while a composer frame is pending waits for the reveal or the winner's composer. A client event whose seq
  arrives after a higher one is still delivered once.
- 4c75f06: The web loads client extensions through a client host: the workspace layout renders an import map
  (with the request's CSP nonce and each entry's integrity), a preload per entry and the plugin
  stylesheets; `ClientHost` imports the entries after hydration (10 s each), checks name, API version
  and component slots, keeps the registry, feeds the plugins' client event listeners, applies the
  crash budget (three errors switch a build off for the browser session), reports failures once per
  document and turns client navigations between the workspace and the admin console into document
  loads. `?safe-ui=1` loads no client code and shows the safe-mode banner; it holds for the browser
  session (a session cookie, cleared by the banner's exit or `?safe-ui=0`), and any plugin
  stylesheet a later render adds is disabled. The error pages offer a reload in safe mode. The host
  shims are generated at dev and build (`gen:client-host`) under `/_capybara/client-host/<webBuild>/`
  with their sha384 in the import map, which the document CSP allows.
- 8968c78: After 应用此插件的外观 succeeds for a plugin with client code, the page reloads so its replacements,
  stylesheets and overlay show at once (the confirm dialog says so). When the live client set adds
  code the open document lacks (a plugin turned on, a new build, the kill switch lifted), a
  non-blocking notice offers 重新加载. In an org's apply preview,
  a current value the org follows from the platform reads 跟随平台：<name>.
- 8627584: Every page document carries a content security policy with a fresh nonce per request:
  `script-src <host>/_next/ <host>/api/v1/client/ 'nonce-<n>'; object-src 'none'; base-uri 'none';
  frame-ancestors 'self'; form-action 'self'` (development adds `'unsafe-eval'`). Scripts never load
  from the rest of the origin, which also serves user content. Next puts the nonce on its own
  scripts; `/api/…`, `/plugin-ui/…`, `/_next/…`, the design catalog `/dev/ui`, `/icon.svg` and the
  object-store proxy keep their own headers, and every other path (dotted ones too) gets the policy.
  The script sources name the host the browser used: a reverse proxy must forward the original `Host`.
- 8a6da5f: The admin console and the workspace manage client code. 平台设置 has 插件界面代码: one switch for all
  plugin interface code and one per plugin with client code (its server side keeps running); a save
  marks every cached client set stale. The admin extension detail shows 界面代码 (build, client API,
  files and sizes, the current build's error reports) with 停用界面代码 / 恢复界面代码. 界面位置 lists
  the replaceable slots with a select 内置 / candidates (an org shows whether it follows the platform
  and can follow it again; members read the picks). 应用此插件的外观 (the admin plugin detail for the
  platform, the extension's Sheet on /extensions for org admins) shows the dry run's changes in a
  confirm dialog, then applies them. Permission reviews show 客户端代码 with the build's files and
  sizes, and interface components as their own sensitive group. A refused apply says what to do at its level
  (the orgs where the theme is off, or how to offer it), and the org-upload confirmation and the org
  Sheet list the client build's files with sizes.
- 8c49d09: The shell element publishes `run=`, `theme=<plugin>/<file id>`, `motion=` and `sidebar=rail|full` in
  `data-cap-state`; the open conversation's log is turned into client events on the client (history
  loaded on open emits nothing). `ThemeRef` gains `key`.
- Updated dependencies [c4b4f6f]
- Updated dependencies [571318f]
- Updated dependencies [f2786a6]
- Updated dependencies [b03397f]
- Updated dependencies [56fc173]
- Updated dependencies [ad030b1]
- Updated dependencies [232191e]
- Updated dependencies [bb622c4]
- Updated dependencies [38e9f9b]
- Updated dependencies [44fe453]
- Updated dependencies [8a3472b]
- Updated dependencies [afeb135]
- Updated dependencies [363a2d3]
- Updated dependencies [914e022]
- Updated dependencies [89278e7]
- Updated dependencies [5d464ce]
- Updated dependencies [8c49d09]
  - @capybara-hq/kernel@0.1.0-rc.15

## 0.1.0-rc.15

### Patch Changes

- Updated dependencies [848fb39]
- Updated dependencies [2f01b01]
- Updated dependencies [155c1cf]
- Updated dependencies [70a50f5]
- Updated dependencies [6622107]
  - @capybara-hq/kernel@0.1.0-rc.14

## 0.1.0-rc.14

### Patch Changes

- Updated dependencies [0a5b15d]
- Updated dependencies [c12e7a7]
- Updated dependencies [17fdfb1]
- Updated dependencies [0e765e2]
- Updated dependencies [18defa0]
- Updated dependencies [cf93278]
- Updated dependencies [199f895]
  - @capybara-hq/kernel@0.1.0-rc.13

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
- 3568c55: Importing a plugin whose connector template has an auth or endpoint object no longer fails with
  `plugin.review_stale`: the review hash is computed over canonical JSON, so the jsonb round trip of
  the stored review no longer changes it.
- Updated dependencies [8469cb8]
- Updated dependencies [3568c55]
- Updated dependencies [f60b796]
  - @capybara-hq/kernel@0.1.0-rc.12

## 0.1.0-rc.12

### Patch Changes

- Updated dependencies [bbd508e]
- Updated dependencies [00e742e]
- Updated dependencies [b2b3faa]
- Updated dependencies [f120273]
- Updated dependencies [2191e44]
- Updated dependencies [c489ee6]
  - @capybara-hq/kernel@0.1.0-rc.11

## 0.1.0-rc.11

### Patch Changes

- dbea14d: Deleting a platform plugin whose extension is still enabled is refused with 409
  `catalog.extension_enabled` (disable the extension first, as an uninstall requires); the admin
  plugin page says so in the delete confirm and links to the extension.
- fa23383: Plugin icons, connector template icons and setup guide files are kept in PG (`catalog_files`,
  migration 0100) instead of object storage, so a bootstrap plugin that ships an icon imports before
  any object store runs and a deployment without an object store still shows icons and guides. The
  staging cleanup removes the ones nothing lists any more.
- eb83fb5: Catalog and marketplace icon fixes. A display file inside a skill directory or at a template's
  path (a plugin icon under `skills/<name>/`) is also stored in object storage, so the platform sync
  of that skill no longer fails. Marketplace icons: a failed icon write is recovered by the next
  refresh at the same commit; failed icon URLs are retried after 6 hours, after the URLs never
  tried; stored icons are checked again (sha256 and content) when served.
- 09dea3e: A connector template file may say `"defaultEnabled": false`: the template then starts switched
  off in every org, even where its plugin is on, until an org admin switches it on, and while off it
  creates no connector and needs no org input (no 需要配置). Ignored for a builtin plugin and for a
  template the super admin gave its own scope.
- c85f0b6: Connector templates shipped `"defaultEnabled": false` show up correctly in previews. Moving one
  from its own scope back to following its plugin lists the orgs it turns off in. A platform update
  no longer asks for input on an added template that is shipped off. An update that changes
  `defaultEnabled` on a template lists, for each org without a switch of its own, the template
  under `needsConfig` (now on) or under the new `turnedOff` (now off, with the agents using it and
  the connectors it keeps). OAuth hardening: an auth preset's `tokenTypes` refuses `DPoP`, and a
  token endpoint's HTTP 200 with RFC 6749's `temporarily_unavailable` or `server_error` counts as
  unavailable instead of a refusal.
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
- 60ce217: IM approval cards show what the web shows, never the raw call input: the approval card's
  `inputPreview` now carries one line, the tool's confirmation summary in the card language (a
  Platform operation's `summary`), else the tool's title and key argument (`Title: arg`), redacted
  and at most 300 characters; the full input stays behind the card's web link. `renderCardAsText`
  labels the line Summary / 摘要 and leaves it out when it is empty.
- 3cbf6e8: Kernel-generated IM text speaks the person's language, not the org's: `/new`, `/env`, bind prompts
  and card-click replies use the sender's platform language, else the bound person's latest web
  message language, else the org's; delivered cards and notices use the language recorded on the
  conversation's latest user message (in a group thread, the person who triggered the run).
  `ChannelSendArgs.locale` carries that language to the extension.
- 5ec789c: IM time zone and language per person: channel@1 `InboundSender` gains optional `timeZone` (IANA)
  and `locale` (`zh` / `en` or a BCP 47 tag). The kernel records on an IM `user_message` the
  platform's zone (when valid), else the account setting, else the org default, and the platform's
  language (`zh` / `zh-*` Chinese, any other tag English), else the UI language of the person's most
  recent web message in the org, else the org's `locale`. Any message without a language uses the
  latest web language the same way, and run start falls back to the author's settings for a message
  from an older log. The fake channel's sender profile takes `timeZone` and `locale`.
- ff9cd78: The workspace 插件 → 市场 tab shows plugin icons too: the org marketplace entries carry `icon`, the
  item's org icon when the org sees the imported plugin, else the marketplace icon on
  `GET /api/v1/orgs/:orgId/marketplaces/:id/icons/:sha256` (org admins, gated like the org browse).
- 2435645: Marketplace rows show icons: an imported plugin its catalog icon, otherwise the icon its
  marketplace entry names. The kernel downloads entry icons on refresh through the marketplace
  network rules (or reads them from a git marketplace's commit), keeps real svg / png files of at
  most 64 KiB in PG (migration 0101) and serves them to super admins on
  `GET /api/v1/admin/marketplaces/:id/icons/:sha256`; the admin entries carry `icon`. A bad icon never
  fails the refresh.
- ebe127f: OAuth connectors work with Slack-like token endpoints. A token response with `token_type: "user"`
  (Slack's `oauth.v2.user.access`) is accepted and sent as `Authorization: Bearer`, like `Bearer`;
  an `oauth_code` / `oauth_client` auth preset may list more accepted types in `tokenTypes`, and
  any other type is still refused (`unsupported_token_type`). A token endpoint error reported as
  HTTP 200 with `{ "ok": false, "error": … }` (or an `error` and no token) is a refusal with that
  code, like a 400: `invalid_refresh_token`, `token_revoked` and `token_expired` join `invalid_grant`
  in deleting the person's connection so they are asked to reconnect, transient codes such as
  `ratelimited` count as unavailable, and other codes keep the credential.
- 48b244e: Plugin icons wherever the kernel shows something a plugin brings: channel connections
  (`pluginIcon`, `pluginDisplayName`), org and admin extensions, model providers and the catalog
  lists carry the URL of their plugin's icon for the reader's scope (org or admin icon route; null
  without one, or when the org may not see the plugin). The web draws it as the mark, falling back to
  the initial, and the org channels page is a card list.
- f74afee: Plugin setup guides: an import validates and stores a plugin's `setupGuides` template files with
  the version; `GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId?mode=&connectionId=&name=`
  renders a guide for the org (the catalog icon's visibility, `channels.manage` for a channel guide)
  with a fixed set of safe variables (`publicUrl`, `webhookUrl`, `signInCallbackUrl`,
  `connectionName`, `orgName`, `pluginName`, `pluginVersion`, `mode`; never a secret). Channel
  connections record the guide they were set up with (`guideAck`, migration 0099), carry
  `setupGuide` and `guideDrift` when an upgrade changed the templates of their mode, and
  `POST /api/v1/orgs/:orgId/channels/:connectionId/guide-ack { hash }` confirms the platform app was
  updated. `GET channels/schema/:plugin` gains `guide`.
- 733a954: After an environment's files are reset (on the environments page, by the Platform operation, or
  after they were lost), each conversation of the environment now learns on its next sandbox command
  that the files were reset, instead of being told the instance restarted with its files kept. The
  kernel counts resets itself, since a provider may give the new file system the old id. A connected
  machine's lost directory recreated by a new `capybara-device login` counts as a reset too. So does a
  new login from another machine, or from another directory or mode on the same machine.
- a4ab6e3: A sandbox provider that can't be reached (connection refused, unknown host, a dropped connection)
  now gives the sandbox tools an actionable error instead of a generic failure: a connection that
  never opened says nothing ran and an admin must check the sandbox extension; one that broke
  mid-call says to check the sandbox before retrying. The raw error stays in the kernel log.
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
- Updated dependencies [6599de8]
- Updated dependencies [2de4f26]
- Updated dependencies [dbea14d]
- Updated dependencies [fa23383]
- Updated dependencies [eb83fb5]
- Updated dependencies [09dea3e]
- Updated dependencies [c85f0b6]
- Updated dependencies [cafa6e4]
- Updated dependencies [c3e12b3]
- Updated dependencies [60ce217]
- Updated dependencies [3cbf6e8]
- Updated dependencies [5ec789c]
- Updated dependencies [ff9cd78]
- Updated dependencies [2435645]
- Updated dependencies [ebe127f]
- Updated dependencies [48b244e]
- Updated dependencies [f74afee]
- Updated dependencies [733a954]
- Updated dependencies [a4ab6e3]
- Updated dependencies [f035baa]
- Updated dependencies [0e8592b]
- Updated dependencies [cb6f42d]
  - @capybara-hq/kernel@0.1.0-rc.10

## 0.1.0-rc.10

### Patch Changes

- ae79508: Documents connected environments: the gateway's `/device/connect` route must be reachable over
  `wss://` on the public origin (WebSocket upgrade allowed, idle connections kept open), the
  `environments.device.*` keys, and the `@device` provider.
- 60fe3b6: The gateway role holds connected machines' WebSocket connections at `GET /device/connect`: the
  machine credential and protocol are checked before the upgrade, one connection per environment
  across replicas under a Redis lease (the newest connection wins), relayed requests are forwarded
  and results written back; revocation, takeover, lease loss and shutdown close the socket.
- Updated dependencies [fe7c389]
- Updated dependencies [cfc888b]
- Updated dependencies [60fe3b6]
- Updated dependencies [af3c477]
- Updated dependencies [ebbfeb5]
  - @capybara-hq/kernel@0.1.0-rc.9

## 0.1.0-rc.9

### Patch Changes

- Updated dependencies [b98e6d1]
  - @capybara-hq/kernel@0.1.0-rc.8

## 0.1.0-rc.8

### Minor Changes

- 40c8ee0: Tools are on by default: an agent has every builtin, every tool of the extensions enabled in the
  org and every tool of the org's connectors, and its definition stores only what it turns off
  (`disabledTools`, replacing the enabled `tools` list; migration 0092 rewrites stored agents and
  org-made templates to "nothing turned off"). A newly added builtin reaches existing agents; a
  connector the org sets up is on for every agent; tools that cannot run now are left out quietly.
  The Platform tool's agent operations and `platform.me` use the new shape. `createAgent` in
  `@capybara-hq/testing` takes `disabledTools`; model-fake calls a tool on its own only when a
  request offers exactly one.

### Patch Changes

- 5f27097: A super admin can clear an extension's deployment config (`DELETE
  /api/v1/admin/extensions/:name/config`): the values and secrets saved in the admin console are
  removed, every replica re-reads, and the extension loads from the startup config or becomes
  pending configuration without a restart.
- fac6134: The agent page's Tools section lists the `CurrentTime` builtin as 获取当前时间 / Current time.
- fac6134: A builtin `CurrentTime` tool: the current local date-time with its UTC offset, the weekday, the time
  zone and the UTC instant. Without `timeZone` it uses the conversation's run context zone (else the
  org default, else UTC); an unknown zone is an actionable tool error. Read-only, allowed by default,
  and on for new agents with the other default builtins.
- b189ebb: The login page's http notice is one sentence for people; the operator details (the cookie and public
  URL settings) moved to a warning on the deployment settings page, a kernel startup warning and the
  deployment docs.
- 58dc1ae: Bootstrap preinstalls the native model platform providers `deepseek`, `bailian` (Alibaba Cloud Model
  Studio) and `ark` (Volcengine Ark) at 0.1.0-rc.0, off in every org until switched on; the official
  marketplace pin moves to capybara-hq/plugins d0cd2d17.
- 7565c72: After an upgrade that added model kinds, a model list cached by the previous kernel made every model
  "not available" for up to ten minutes. The cache key now carries the format of the cached list.
- b0f3c1c: The Platform tool's `browse` and `search` list each operation's input keys, so agents stop guessing
  parameter names before a call.
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
- 71858cf: An extension unloaded because a required extension point lost its provider re-reads its deployment
  config when the provider returns: it comes back on the config saved meanwhile, and stays pending
  configuration when its config was cleared, instead of returning on the old values and secrets.
- ca3c570: Agents know who they are and who they talk to (run context): run start writes a `run_context`
  event (the agent version's name and description, the org, today's date, the time zone and language
  of the person whose message started the run; a sub-agent's own name and who dispatched it), first
  in full, then only what changed; the model sees it as a system message at its position and in full
  again after a compaction summary. Every message records its sender (display name and org role; an
  anonymous IM guest by IM name) and a sender line names it when the sender changes. Messages take
  the browser's `timeZone` and `locale`; `GET` / `PUT /api/v1/me/preferences` sets a person's time
  zone, the org settings an org default (`timeZone`). The agent definition gains `description`
  (saved as a version; the profile PATCH no longer takes it). model-fake reads a message's script
  without the sender line.
- 1a2bcf6: Every message send carries the browser's time zone and UI language; a new personal 偏好设置 page
  sets a time zone (default: follow the browser) and the org settings page an org default time zone.
  The agent page saves its description into the agent's version, so the agent knows it.
- 306bb00: The bundled sandbox-docker plugin moves to the sandbox@2 release (0.1.0-rc.4) and the sandbox profile of the compose files now pulls the published images; building them locally moved to the `sandbox-build` profile.
- 19f7c97: The bundled sandbox-docker plugin moves to 0.1.0-rc.5 (sandbox images `0.1.0-rc.5`), and the marketplace pin
  to the plugins commit that released it. The e2b plugin of the same release kills a command's children that left
  its session.
- Updated dependencies [fac6134]
- Updated dependencies [58dc1ae]
- Updated dependencies [e0f22ae]
- Updated dependencies [489ef01]
- Updated dependencies [8a016b4]
- Updated dependencies [89b1439]
- Updated dependencies [71858cf]
- Updated dependencies [ca3c570]
- Updated dependencies [40c8ee0]
  - @capybara-hq/kernel@0.1.0-rc.7

## 0.1.0-rc.7

### Patch Changes

- Updated dependencies [4a92acb]
  - @capybara-hq/kernel@0.1.0-rc.6

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
- 90c6125: Bootstrap plugins: `openai-compatible` and `object-store-s3` move to 0.1.0-rc.1, and the manifest preinstalls `anthropic`, `openai`, `connector-mcp`, `connector-openapi`, `jina`, `sandbox-docker` and `todo` as optional entries (installed and enabled on the deployment, off in each organization until an org admin switches them on). `marketplace.commit` and the compose sandbox build contexts move to the plugins commit that lists them.
- 9f554a3: Org members can read the org's 扩展 page: `GET /api/v1/orgs/:orgId/extensions` is the new action
  `org.extensions.read` (member and up); a member gets each extension's state without its config, the
  secrets' state, the config schema or the permission list, admins keep the full view. The page
  hides every switch and config control for members.
- 2321382: A platform inbox for the super admin: `GET /api/v1/admin/inbox` (with `total`, and `GET /api/v1/admin/inbox/count` for the sidebar) lists the orgs' requests to the platform (`access` / `import`), plugins whose extension permissions wait for a confirmation, open plugin scope sync failures, including dependencies a platform update added that could not be installed (recorded per item and org in the new table `plugin_scope_sync_failures`, migration 0083, until a later sync of the pair does not fail) and the latest platform components migration run when it failed plugins or is stuck. The admin console gets a 收件箱 page (`/admin/inbox`) and a sidebar item with its count; each item links to the page where it is acted on.
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

- e555e04: The agent map opens one sub-agent's summary (latest text, task, background tasks, tool calls newest
  first, Stop while it runs) and its read-only transcript; an `Agent` call block names the child's
  current tool and opens it in the map. A sub-agent's reports and its end show in the parent as notice
  lines, and a parent's messages in a sub-agent's transcript as bubbles labelled with the sender.
- 1556a45: The conversation page opens an agent map of the conversation's sub-agents (from the sub-agent
  group's header and a title-bar icon), kept in the URL hash; the org sub-agent limits dialog sets the
  nesting depth and counts dispatches and tokens over the whole tree since the person's latest message.
- 3a4b54b: The agent page's Tools section puts each tool's policy on its row (a new `ToolPolicyList`): the
  built-in tools stay in the card, and each extension or connector is one row with a summary that
  opens a Sheet with its tools, select-all and a filter. A connector can now be taken tool by tool.
  The connector detail's tools carry their display `title`.
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
- 357c521: A sub-agent that handed back its report and then completed no longer sends its parent a separate
  "completed; its report was already delivered" notice: the finish is only logged, so it neither
  wakes an idle parent for an empty run nor pushes the report away from the end of the request. The
  conversation still shows the agent's "completed" entry.
- 9e90494: Bootstrap plugin `openai-compatible` moves to 0.1.0-rc.2: the DeepSeek dialect sends
  mid-conversation system notices (sub-agent reports, background notices, tool-change reminders) as
  in-place `[system]` user turns, so DeepSeek no longer moves them ahead of the conversation.
- 237c176: The model purpose APIs return `declaredByName`, the declaring extension's display name.
- bdd3fa3: A sub-agent stopped by its tree's token budget hands back what it found in one final tool-less
  call instead of ending with nothing. `subagents.maxTokensPerRun` and `subagents.maxDispatchesPerRun`
  accept 0 for no limit (deployment config and org override), and `GET /api/v1/admin/orgs` returns the
  deployment's defaults of the per-org limits (`limitDefaults`).
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
- 47c4241: The workspace has no home page any more: the new conversation is the home. `/` redirects to `/chat`,
  新会话 is the current nav item there, and sign-in, setup, an org switch, the not-found page and the
  path's org scope all go to `/chat`. The sidebar reads 新会话 · 智能体 · 技能 · 连接器 · 更多; 技能 and
  连接器 left the 更多 flyout, which keeps 插件, 扩展, 智能体模板, 渠道, 评测与运行 and 组织设置.
- Updated dependencies [49ae0b5]
- Updated dependencies [f222ff8]
- Updated dependencies [d423777]
- Updated dependencies [3a4b54b]
- Updated dependencies [0f383d7]
- Updated dependencies [8f7a0a5]
- Updated dependencies [da49ebd]
- Updated dependencies [90c6125]
- Updated dependencies [16225b1]
- Updated dependencies [3c0ad62]
- Updated dependencies [789068d]
- Updated dependencies [7c8d05e]
- Updated dependencies [abc772e]
- Updated dependencies [8ee4c6c]
- Updated dependencies [2a12327]
- Updated dependencies [12fd552]
- Updated dependencies [3adad42]
- Updated dependencies [9f554a3]
- Updated dependencies [8fd18a1]
- Updated dependencies [9e90494]
- Updated dependencies [e40774d]
- Updated dependencies [99a00cd]
- Updated dependencies [e0a0d60]
- Updated dependencies [ffc33a2]
- Updated dependencies [45d7275]
- Updated dependencies [5ac4bba]
- Updated dependencies [2fb7d41]
- Updated dependencies [2321382]
- Updated dependencies [3c45446]
- Updated dependencies [cc21d5c]
- Updated dependencies [a965a1a]
- Updated dependencies [7278dec]
- Updated dependencies [bdf5eba]
- Updated dependencies [703c779]
- Updated dependencies [77de995]
- Updated dependencies [11f56fa]
- Updated dependencies [927fad3]
- Updated dependencies [7a1e1ae]
- Updated dependencies [0e38b13]
- Updated dependencies [cfee6f0]
- Updated dependencies [26e8757]
  - @capybara-hq/kernel@0.1.0-rc.5

## 0.1.0-rc.5

No changes in this release.

## 0.1.0-rc.4

### Patch Changes

- 49fa38b: A kernel whose stdout reader is gone no longer spins and ignores signals. When the reader of
  the console exits (the `tee` of `pnpm dev:kernel` stopped by Ctrl-C, a closed pipe), every log
  write failed with EPIPE as an uncaught exception, the process guard logged it (another write,
  another EPIPE), and the endless chain of errors held the CPU at 100% and starved the exit, the
  stop budget and a second signal. The logger now stops writing to a console stream after its first
  error, and the guard logs nothing more once it decided to exit. `pnpm dev:kernel`'s log file
  writer ignores Ctrl-C, so the shutdown's records reach `/tmp/capybara-dev-kernel.log` too.
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
- Updated dependencies [ce0e90c]
- Updated dependencies [9d134ee]
- Updated dependencies [0344386]
- Updated dependencies [1e092a6]
- Updated dependencies [9e9ce5b]
- Updated dependencies [0ec51d1]
- Updated dependencies [8e43ed7]
- Updated dependencies [9b89920]
- Updated dependencies [258d286]
- Updated dependencies [69b3bbe]
- Updated dependencies [489d640]
- Updated dependencies [58d08b1]
- Updated dependencies [70688ca]
- Updated dependencies [49fa38b]
- Updated dependencies [0f1507e]
- Updated dependencies [80f4844]
- Updated dependencies [76da814]
- Updated dependencies [8e928cb]
- Updated dependencies [3455513]
- Updated dependencies [81adaff]
- Updated dependencies [4ef89b8]
- Updated dependencies [c01c117]
- Updated dependencies [f28ed05]
- Updated dependencies [2bd8351]
- Updated dependencies [c9c8625]
- Updated dependencies [8f7ba64]
  - @capybara-hq/kernel@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- Updated dependencies [8bf0b04]
- Updated dependencies [e1127f5]
- Updated dependencies [307c611]
- Updated dependencies [1beea7e]
- Updated dependencies [56e83dd]
- Updated dependencies [48d3983]
- Updated dependencies [a1bfe76]
- Updated dependencies [0f4b28a]
- Updated dependencies [8881b9a]
- Updated dependencies [32580d3]
- Updated dependencies [75b1aaf]
  - @capybara-hq/kernel@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

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
- Updated dependencies [e23c2b6]
- Updated dependencies [a0bc577]
- Updated dependencies [de0d460]
  - @capybara-hq/kernel@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- 4a7726f: `capybara` loads `.env` from the working directory before every command (variables already set in
  the environment win); `--env-file <path>` loads another file and `--no-env-file` none.
- 75d7a0c: `capybara start` logs with the configured format and outputs (`log.format`, `log.loki.*`) and
  flushes the Loki buffer before exiting. Optional OpenTelemetry tracing: with
  `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) set, `capybara start`
  exports OTLP traces of HTTP, Nest, fetch, PostgreSQL, Redis and queue jobs, and log records carry
  `traceId` / `spanId`; without it no OpenTelemetry module is loaded.
- 6aaf28b: `capybara start` always runs the bootstrap step (when it is not done for the manifest), from the
  offline directory of config `bootstrap.dir` (default `./bootstrap`, `/app/bootstrap` in the image)
  or else downloading the pins from `packages.npmRegistry`; `--bootstrap-dir` is removed.
  `capybara bootstrap --dir` defaults to the same directory and downloads what it does not hold.
- 6ad094b: The kernel images no longer carry the bootstrap plugin packages: compose `init` (or the first
  `capybara start`) downloads them from npm (`CAPYBARA_PACKAGES__NPM_REGISTRY` for a mirror), and an
  offline deployment mounts a directory holding the pinned tgz files at `/app/bootstrap`
  (`CAPYBARA_BOOTSTRAP__DIR`). The `NPM_REGISTRY` and `NODE_USE_ENV_PROXY` build arguments are gone.
- Updated dependencies [75d7a0c]
- Updated dependencies [e69c9d6]
  - @capybara-hq/kernel@0.1.0-rc.1
