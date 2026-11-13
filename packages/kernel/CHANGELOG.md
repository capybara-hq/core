# @capybara-hq/kernel

## 0.1.0-rc.28

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
- Updated dependencies [f78281b]
  - @capybara-hq/plugin-sdk@0.1.0-rc.21

## 0.1.0-rc.27

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

## 0.1.0-rc.26

### Minor Changes

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

### Patch Changes

- 76828c0: Device policy ops carry an op id. The device protocol's `policy` op now requires `opId` (non-empty,
  no `:`, at most 128 characters); the new `policyStatus` op asks a device what became of an op id
  (`applied`, `refused`, `started` or `unknown`, with its policy summary now); a hello may carry
  `recentOps`, the outcomes of the latest 100 policy ops; the new feature `policyOpId` announces all
  three. `capybara-device` logs each policy op in `policy-ops.json` next to `policy.json` (`started`
  before the change, then `applied` or `refused`; the last 100 kept), answers a repeated op id from
  that log without applying it again, and reports the log in every hello. The kernel sends its op id
  with each `policy` op.
  
  The SDK's hello parser keeps one `recentOps` entry per op id (the last one listed). `capybara-device`
  keeps a refusal's message in the log cut to 500 characters, never logs an applied op as refused
  when releasing the policy lock fails after the write, and keeps an op the log already says was
  applied as applied.
- 47ef322: A person's stop of a conversation now stops every running sub-agent below it too, and the
  conversation stays stopped: no sub-agent finish or report starts it again until the next message,
  whose run sees what they delivered. The conversation's own background Bash tasks keep running.
- b6b8d13: TaskOutput given a sub-agent's agentId answers where its report arrives instead of failing the call; TaskStop still refuses it.
- a9f726b: The last direct job adds follow the transactional outbox or say why they need not. An eval run's
  start owes one case job per case in the transaction that writes the run, so a crash after the
  start no longer leaves a run waiting for jobs that were never added (the "enqueue failed" path
  that marked such a run failed is gone). A background task finish or delivery inside a
  conversation's wake window owes the delayed `bg-wake` job in the transaction that found it, so the
  wake is no longer lost when the process dies or Redis is down. A channel connection that is
  re-enabled, or gets new credentials while active, owes its catch-up (`channel-resume`) in the
  update's transaction, so the replies held back meanwhile are no longer left unsent by a crash. The eval queue's jobs are named
  `eval-case`.
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
  - @capybara-hq/plugin-sdk@0.1.0-rc.20

## 0.1.0-rc.25

### Minor Changes

- b4d2b44: Plugin scope syncs follow the transactional outbox: a scope change, a deployment-level disable or
  enable, a 可共享 switch-off that narrows a plugin, an approved access request, an ownership
  transfer, a platform plugin update and a new org owe their `scope-item` / `scope-org` job in the
  transaction that makes the change, and a confirmed import or org upload owes it right after its
  extension is deployed. The removal of an org-owned plugin owes its `owned-plugin-cleanup` job with
  the removal. A crash or a Redis outage after the commit no longer loses the sync, so the worker no
  longer re-enqueues every plugin's sync at start and the daily owned-plugin cleanup sweep is gone. A
  migration that changes a scope inserts the outbox rows itself.
  
  A plugin import writes its platform components (skills, agent templates, connector templates,
  themes) in the import's transaction, and so does the super admin's confirmation of an org upload's
  first version: their files are copied before it under a key made from their content, so a failed
  import leaves no item and a retry copies nothing again. The worker job
  `platform-components-migrate` and its retry after a failed post-import sync are gone. Removing an
  org upload still awaiting confirmation owes its cleanup too.
  
  With the job gone, the platform inbox no longer has a "platform components migration" item and
  the org inbox no longer has the `skill_renamed` notice (only that job wrote it): migration 0121
  drops `platform_migration_runs`, deletes those notices and narrows the notice kind check.
- 240801c: Scheduled task fires follow the transactional outbox: the transaction that writes a pending task
  run (the scan's tick, a person's "Run now") owes its `sched-fire-<taskRunId>` job in the outbox, so
  a crash or a Redis outage after the commit no longer loses a tick. The scan's repair is gone (no
  re-enqueue after 10 minutes, no give-up after an hour, no recheck of started runs) and with it the
  `scheduled_task_runs.rechecked_at` column (migration 0122). A tick whose fire job runs more than 10
  minutes past the org's catch-up window (workers down for long) is still skipped as `missed`, now by
  the fire job itself; a "Run now" still runs. The fire job's claim owes a settle check 10 minutes on
  (`sched-settle`): a run claimed but never started (its start failed for good) is linked, settled or
  released as the scan's recheck did, so a once task's last run never stays pending. The tick and "Run
  now" also owe an unfired check: a run whose fire job failed for good before claiming it is skipped
  (`missed`, or `removed` for a "Run now") instead of blocking every later tick as an overlap.
  
  Offboarding follows the transactional outbox: removing a member, a member leaving and a directory
  sync offboarding owe a `run-stop` job for each of the person's active runs in the org and a
  `sandbox-destroy-for` job for each of their devices, in the offboarding's transaction. Deleting a
  device owes its destroy the same way, under `device-destroy-<deviceId>`. A crash or a Redis outage
  after the commit no longer leaves a departed member's runs going or their devices standing, so the
  10-minute offboarding sweep is gone; the session revocation markers stay hints (`revoked_at` in
  PG decides). Offboarding locks the conversations it touches tree by tree, root first, so it no
  longer deadlocks with a reply that skips a sub-agent's network ask.

### Patch Changes

- fc46148: Call `context@1` providers at a chat run's start: every provider enabled in the org with a valid
  config is asked in parallel (2 s each, outside any transaction), and a `plugin_context` event is
  appended when its text changed; a throw, a timeout or text over 32 KB is skipped and logged, and a
  provider switched off in the org gets an empty event. The import review shows `provides
  context@1` as adding text to the model's context. Tool step contexts now always carry the source,
  the owner and the role. `@capybara-hq/testing` gains the `fake-context` fixture.
- 23c16d8: Conversations record where they come from (`conversations.source`: `web`, `channel_dm`,
  `channel_group` or `subagent`), set at creation and never changed. Migration 0124 adds the column
  and backfills existing conversations from their kind, their channel thread rows (archived ones
  included) and, for a group run whose thread is not bound yet, their delivery target.
- b7e70f7: Deliver the lifecycle hooks `org.member_removed`, `agent.deleted` and `org.deleted` durably: one
  job per subscribing plugin is owed through the transactional outbox in the deleting transaction and
  delivered through the `cap-kernel-lifecycle` queue, with retries (shown in the admin overview's
  queues). Add the fake extension `fake-lifecycle`.
- b177905: The compose files and test containers run PostgreSQL 17 with pgvector (`pgvector/pgvector:pg17`),
  and migration 0123 creates the `vector` extension in `public` when the server offers it and the
  migrating role may create it; otherwise it only raises a notice, and plugins fall back to `real[]`.
  `@capybara-hq/testing` exports `startPostgresContainer` (with an `image` option) and `TEST_PG_IMAGE`.
- fcfabb4: Offer an extension tool only in the conversation sources its `spec.sources` lists (hidden with the
  reason elsewhere, a resumed call refused), and give plugin tool handlers the conversation's
  `source`, its owner (`ownerAccountId`) and the trigger account's `role`. `fake-tools-ui` gains the
  tool `web-only`.
- Updated dependencies [da677b6]
  - @capybara-hq/plugin-sdk@0.1.0-rc.19

## 0.1.0-rc.24

### Minor Changes

- c619811: A transactional outbox: work that must follow a commit is a row in `capybara.outbox` written in the
  same transaction (`OutboxService.add`), delivered right after the commit by a fast path and, when
  that fails, by a relay on the worker role every 2 s; failures back off and after 20 attempts the
  row is a dead letter the super admin sees in the overview (无法排入队列的后台任务) and can retry or
  discard (`/api/v1/admin/outbox/dead`, Platform operations). New checks `kc-enqueue-via-outbox`,
  `kc-after-commit-hint` and `check:outbox-registry` (migration 0119).
- b8a3c5b: Runs follow the transactional outbox: a run's job, its ensure-run backstop, resumes, wait timeouts,
  sub-agent dispatches, deliveries and tree stops are owed in the transactions that cause them. A run
  nobody runs any more is repaired by one `run-orphan-check` (worker role, every minute): a running
  run whose replica died is failed `run.orphaned` and reported to its parent; a queued run whose job
  the queue lost is queued again and shown in the admin overview (队列丢失了后台任务). Reading a
  conversation (events, SSE) no longer changes run state, the wait sweep is gone, and a finished run
  cancels its pending approvals and questions in its terminal transaction. The dual-replica harness
  fails `stop()` when the replicas left a queued run without its job.
- 36d904d: Usage reports follow the transactional outbox: a `usage.report` delivery is owed in the transaction
  that writes the usage it reports (a model call's, compaction's, title's or `WebFetch` extraction's
  `usage` event, an embed call's `model_usage` row), while the deployment has at least one enabled
  extension that declares the hook. That is read from the database (cached 30 s per replica, cleared
  when plugins change), so a replica without the handler still owes the report another replica
  delivers. Usage written while no extension subscribed is not reported later. The usage sweep, its
  watermark table (migration 0120) and `hooks.usageReportKeepHours` are gone: finished delivery jobs
  are kept 24 hours.
  
  IM delivery is owed too: an event append to a conversation with a channel target (a reply, an
  approval decision, a question answer, a wait stop) adds the conversation's deliver job to the outbox
  in its own transaction, and binding a conversation to its IM target owes the first one with it, so a
  crash or a Redis outage after the commit no longer loses the reply or the card update. A
  conversation without a channel target writes nothing more. The in-process
  `conversation.event-appended` and `run.wait-stopped` events are gone; `run.started` stays a hint
  that starts streaming drafts at once.

### Patch Changes

- ba36733: A device's recent sandbox changes now list the policy changes its owner makes on the machine
  (`capybara-device policy ...`: tier from and to, localhost, allowed domains added and removed,
  isolation, remote grants) as 本机 beside the web's, each change once.
- 9370947: Updating an installed platform plugin to a newer version is one wizard: 更新到 vX on the admin
  plugin list, the plugin's page and the marketplace tab stages the version and shows the import
  review, then the platform update preview; one confirm applies both (`GET
  /api/v1/admin/catalog/imports/:stagingId/update-preview`, `POST …/imports/:stagingId/update`).
  Cancelling writes nothing; an update failing after the import says so (409
  `plugin.imported_not_updated`) and leaves the platform on its version. An installed plugin is no
  longer imported on its own; the 版本 tab moves the platform to another imported version (更新到 /
  回退到). A plugin not installed yet shows 安装 instead of 导入 / 引入.
- e2731bd: New builtin tool `TaskList`, offered with `Bash` like `TaskOutput` and `TaskStop`: it lists the
  conversation's own background tasks (running first, then the 20 most recently finished, with id,
  description, status, elapsed time, exit code and output file) and the sub-agents it dispatched.
  Read-only and allowed by default; `status: "running"` lists only what still runs. `TaskOutput`'s
  not-found error and the `Bash` description point to it.
- 86c258c: Agent runs have no step limit and no duration limit by default: `runtime.maxSteps` and
  `runtime.maxRunSeconds` default to 0 (no limit), so a run goes on until the model stops calling
  tools or someone stops it. Without a run duration limit, sandbox commands are limited only by
  `sandbox.limits.maxCommandSeconds` and the tool timeouts; explicit positive limits work as before.
- Updated dependencies [67e6ad5]
- Updated dependencies [e76028b]
  - @capybara-hq/plugin-sdk@0.1.0-rc.18

## 0.1.0-rc.23

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
- Updated dependencies [a3ca5ef]
  - @capybara-hq/plugin-sdk@0.1.0-rc.17

## 0.1.0-rc.22

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

- 2682d5f: Agent templates turn skills off with `disallowedSkills` (`<plugin>:<name>`, `<plugin>:*` or a bare
  `<name>`, at most 64; `isDisallowedSkillRef`) instead of selecting them: `selectedSkills` is
  removed. Creating an agent from a template turns those skills off and lists every name in `skills`
  as carried or unavailable; saving an agent as an org template writes its off-list.
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
- e808481: Skills are on by default in the web app: the agent page's 技能 section lists every skill on in the
  org checked, and unticking one turns it off (`disabledSkills`); a plugin's group head turns the
  whole plugin off, its later skills too. Pinning is gone (the 置顶 section, the pinned suggestions
  of plugin import, the token estimates). The agent template editor edits `disallowedSkills` with the
  same list and the skills a sub-agent loads first. The org 技能 page filters by plugin and its
  detail says how many agents turned a skill off (`agentsOff` on the skill detail); switching off a
  plugin with skills says every agent loses them; the admin agent pages show the off count.
- f1331fe: `subagents.maxTokensPerRun` now defaults to 0 (no limit); set it, or an org override, to cap sub-agent tokens.
- bfb35e3: Tool rows no longer read a Bash command's non-zero exit as a failure (only a timeout or a stopped
  command fails; the summary names the exit code), and an `Edit` / `Write` refused by the
  read-before-write check carries the display-only `tool_result.view.kind: "guard"`, shown as
  "Blocked: read the file (again) first" and counted apart from failures; the model still gets the
  same error result
- Updated dependencies [2682d5f]
- Updated dependencies [2e52ca1]
- Updated dependencies [8fa0e32]
- Updated dependencies [95fc4b0]
  - @capybara-hq/plugin-sdk@0.1.0-rc.16

## 0.1.0-rc.21

### Minor Changes

- ac35f95: Bootstrap manifest entries may be `builtin: true`: builtin in the catalog, imported after the
  extensions load (so they may ship skills), and a failure does not stop the start

### Patch Changes

- c371130: Bootstrap pins the builtin `skills-core` plugin (skill-guide); compose's init waits for the
  object store, where the bootstrap's second pass stores its skills
- 6d9e768: Bootstrap pins move to the plugin versions the official marketplace lists at capybara-hq/plugins
  14c73d5 (openai-compatible rc.7, object-store-s3 rc.6, sandbox-docker rc.10, the rest likewise)
- Updated dependencies [ac35f95]
  - @capybara-hq/plugin-sdk@0.1.0-rc.15

## 0.1.0-rc.20

### Minor Changes

- fc9cbe6: Agents author skills with files and the Platform tool; SkillWrite removed

### Patch Changes

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
- 3756b00: The permission review's 密钥 group names each secret field with its level (`deployment:appSecret`,
  `org:appSecret`) like the config group, so a secret declared at both levels is no longer one name
  listed twice (which also broke the web list's keys).

## 0.1.0-rc.19

### Patch Changes

- b4816fc: Component lists and details carry `descriptionZh` (a theme's or skill's `description.zh`), and the
  web shows a theme's, skill's or agent template's description in the UI language (the org 外观
  page, the admin component cards and details).
- Updated dependencies [6a4ffff]
  - @capybara-hq/plugin-sdk@0.1.0-rc.14

## 0.1.0-rc.18

### Minor Changes

- a49c72e: Client code can do something once per sign-in: `useSignIn()` and `ClientApi.signIn` carry an
  opaque id that stays the same for one sign-in and changes on the next one (a different string per
  plugin, not a secret between plugins).
  The kernel's client shell reads return it per item (`signInId`, a keyed hash of the session, never
  the session id) and the web host hands it to plugins; the fake host takes `signInId`.

## 0.1.0-rc.17

### Patch Changes

- fa555e9: A message from the run's starter skips the run's pending questions: the question becomes `skipped`
  (migration 0108), `question_answered` carries `outcome: "skipped"` and `skippedBySeq`, the run
  resumes at once and the kernel writes a fixed result (the tool is not called again; MCP elicitation
  and extension input requests too); the message follows as an ordinary user message. Every question
  write locks the conversation row first. IM question cards carry `textReply` (`plain` in a DM,
  `mention` in a group thread) and the `skipped` state; trajectories show the skip.
- Updated dependencies [7423fa7]
  - @capybara-hq/plugin-sdk@0.1.0-rc.13

## 0.1.0-rc.16

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
- 0be1551: The permission review lists client components in a group of their own (`components`, items are
  the component ids, always sensitive) instead of under `ui` (views and embeds).
- Updated dependencies [bae65fe]
  - @capybara-hq/plugin-sdk@0.1.0-rc.12

## 0.1.0-rc.15

### Minor Changes

- ad030b1: Client builds are stored per package: migration `0107_extension_client_builds.sql` adds
  `extension_client_builds` and `extension_client_reports`. When a package with an `extension.client`
  section is stored, its client files are read again from the stored bytes, checked against the
  section (every key exact, listed = present, size limits, sha384 recomputed, each stylesheet one
  `@layer extensions` block with no `@import` and every `url()` an asset of the plugin, `data:` or a
  `#fragment`, no non-ASCII whitespace, zero-width character or U+FEFF, no `image-set()`,
  `cross-fade()`, `element()`, `paint()`, `src()` or `image()`; key segments of `[A-Za-z0-9._-]` only) and written under
  `deployment/platform/client/<plugin>/<sha256>/`; the build row's integrity is what was recomputed.
  New error codes `client.undeclared`, `client.integrity_mismatch` and `client.invalid` (400); a
  package with client code is refused with `storage.unavailable` without object storage. The import
  review re-checks the client files, checks `suggestedAppearance.theme` against the scanned themes
  (`appearanceIssues`) and lists the client files with their sizes (`extension.client`). An expired
  org upload's package takes its client files with it. The CLI's `capybara plugins import` stores client
  files in its own object store (`loadCliObjectStore`).
- 232191e: The kernel delivers plugin client code. `GET /api/v1/client/<plugin>/<build>/<path>` serves the
  entry, stylesheets and assets of a client build (`build` is the package sha256) to a signed-in
  member, any role, of a live org where the extension is enabled, or to a super admin when the build
  has a `platform.page` component; only while a live replica serves the build's package for an
  enabled install (client code follows the server code that runs: during an upgrade awaiting
  approval or after a failed one the old build stays served; replica status rows gain
  `serving_sha256`) and the permission snapshot approves `permissions.client` and every
  `ui.component:<id>`.
  Files are looked up by their exact manifest key (no decoding, no normalising, never a redirect);
  anything else is 404 `client.not_found`. Responses are `private, max-age=31536000, immutable` with
  `nosniff` and `Cross-Origin-Resource-Policy: same-origin`; SVG assets carry
  `default-src 'none'; sandbox`. `GET /api/v1/orgs/:orgId/ui/client` (guest and up) lists the org's
  client extensions with file URLs, integrity and the components the viewer's role may use;
  `GET /api/v1/admin/ui/client?plugin=` (super admin) lists only `platform.page` components and no
  stylesheets. Both are `no-store`. The deployment setting `clientExtensions: { enabled, disabled }`
  (default `{ enabled: true, disabled: [] }`, written by `PUT /api/v1/admin/settings` and the
  Platform operation `admin.update-settings`) stops all client code or that of the listed plugins.
- bb622c4: The permission review covers client code: `permissions.client` and `ui.component:<id>` are new
  permission keys (`PermissionSet.permissions.client`, `permissions.ui.components`), both sensitive
  (reasons `client_code` and `ui_component`, a new `client` group) and blocking until the super admin
  approves; `capybara extensions review` / `approve` mark them `(sensitive)`. Only `ui.view:*` stays
  non-blocking. An upgrade that changes only the client bundle adds no key; older snapshots without
  the fields read as no client code.
- 44fe453: The kernel collects crash and load reports of client code. `POST /api/v1/orgs/:orgId/ui/client/
  reports` (guest and up) and `POST /api/v1/admin/ui/client/reports` (super admin) take `{ plugin,
  build, contribution, kind, message }` (`kind`: `load`, `render`, `event`, `api` or `budget`;
  `message` at most 500 characters) and answer 204; one row per (plugin, build, org, contribution,
  kind) is upserted with a count. A report is accepted only for a build the reporter could fetch
  (and, in an org, an extension enabled there), else 404 `client.not_found`; 20 reports a minute per
  account (429). A daily `@LockedCron` on the worker role deletes reports not seen for 30 days. The
  admin extension view gains `client` (the install package's client build: files with sizes and the
  API version) and `clientReports` (that build's newest 50).
- 8a3472b: The permission reviews carry the client build (client extensions spec §5.4). `GET
  /api/v1/admin/catalog/items/:id` gives each version `client`: its extension package's build (files
  by manifest key with their sizes in load order, `totalBytes`, `apiVersion`; null without one), so
  the confirmation of an org's upload shows the pending package's files and sizes. The org extension
  list and `PUT …/extensions/:extension` give org admins `client`, the running package's build, for
  the Sheet's 客户端代码 group; members never get it.
- afeb135: The kernel applies a plugin's suggested appearance in one step (应用此插件的外观).
  `POST /api/v1/admin/catalog/items/:id/appearance` (super admin) sets the plugin's theme as the
  platform default theme and each suggested replacement as the platform arrangement's `use`;
  `POST /api/v1/orgs/:orgId/extensions/:extension/appearance` (`org.update`, the extension on in the
  org) does the same for the org, keeping `personal`. Body `{ dryRun? }`; the answer lists `theme`
  (`{ from, to }` or null), `replacements` (`{ slot, from, to }`) and `skipped` (`unknown-slot`,
  `not-available`, `not-eligible`). Both writes go through the settings writers in one transaction:
  a theme that cannot be set there refuses the whole call with `theme.not_available`; a replacement
  that is not available is skipped. The admin item detail and the org extension list (admins) gain
  `suggestedAppearance`. Platform operations `plugins.platform-apply-appearance` and
  `plugins.apply-appearance` mirror the routes (confirmed every time, never remembered; the dry run
  is their card and precheck).
- 363a2d3: A theme's stylesheet is one `@layer theme { … }` block, in the layer order the design stylesheet
  declares (design, theme, extensions). Its URL carries a render revision,
  `/api/v1/themes/<id>/<version>/r<n>/theme.css` (`THEME_CSS_REVISION`, now 2, bumped whenever the
  output format changes): only the current revision is served (404 `theme.not_found` otherwise) and
  the old URL without a revision is gone, so no browser keeps an older format cached as immutable.
- 89278e7: The UI routes serve component contributions: the contributions list carries `kind: "component"`
  (listed with or without a server view), `ctx.ui.view` / `ctx.ui.action` accept ids in
  `permissions.ui.components` and such a view is served like a view of its slot (the slot's role and
  scope rule decide access). Only a component's view may carry `data` (a plain view's or action's
  `data` is 502 `ui.invalid_view`). A tool's `ToolResult.card` may name a component card. The UI
  arrangement gains `{ use }` for single slots (`shell.brand`, `conversation.empty`,
  `conversation.composer.frame`): the org's entry, else the platform's, picks the winner; `use: null`,
  no entry or a `use` naming a contribution not available in the org is the built-in. The
  contributions list shows at most the winner of a single slot, and `GET …/ui/arrangement` lists a
  single slot as `{ slot, candidates, use, followsPlatform }`. `use` on a list slot and `hidden` /
  `order` on a single slot are 400 `validation_failed`. `capybara-plugin check` (`perm-ui`) accepts
  component ids for `ctx.ui.view` / `ctx.ui.action`.

### Patch Changes

- c4b4f6f: Applying a suggested appearance at org level reports `from` as the value in effect (the org's own
  entry, else the platform's) with `followsPlatform`, and pins nothing when the org follows a
  platform that already uses the suggestion. Replacements are listed and applied in plugin.json
  order (recorded at import in `catalog_item_versions.appearance_order`, since the jsonb manifest
  does not keep key order; the item detail and the org extension list show them in that order). A
  second ref to one slot is skipped as `not-eligible`, and `parsePluginManifest` refuses it
  (`shell.brand` and `shell.brand@1` in one `suggestedAppearance.replacements`).
- 571318f: A super admin confirming an org upload while the org is deleted, the plugin removed or a
  replacement version uploaded no longer fails with 500: every path takes the catalog item row
  before the per-name install lock (the extension install, the import confirm, the plugin delete),
  so none of them can deadlock. A confirmation whose item was removed under it answers 409
  `catalog.item_removed` (refused before installing anything, and also when the removal's cleanup
  took the extension out between its steps, for a first or a new version) instead of 404
  `extension.not_found`.
- f2786a6: At org level, applying a suggested appearance judges the followed platform default theme by its
  eligibility: a stored default that is no longer eligible renders the built-in, so applying the
  plugin's theme is reported as a change. `permissions.client: true` without a client section is
  reported as "permissions.client is true but extension.client is missing".
- b03397f: A bootstrap import of a plugin with client code (`extension.client`) is refused with
  `client.invalid`, naming the plugin and saying to take it out of `bootstrap.json`: client files are
  kept in object storage, which a bootstrap run may not have.
- 56fc173: A plugin whose client code was built for a newer client API than the kernel's `CLIENT_API_VERSION`
  is refused at import with `client.api_unsupported` (400), and the client shell reads never list a
  build of a client API version the web host does not run.
- 38e9f9b: Client reports are bounded: a report's `contribution` must be null or a component id of that
  build's manifest (another id is 404 `client.not_found`, a string outside the component id grammar
  400), and the admin extension views read at most the newest 50 reports per extension in SQL. The
  admin view's client build is the one a live replica serves (the old build beside an upgrade
  awaiting approval or failed), not the install record's package. The delivery route refuses builds
  of a client API version the kernel does not support, as the shell reads already omit them. A
  replica whose running instance's own package goes pending or failed still reports serving it, so
  its client code stays.
- 914e022: `ctx.ui.view` / `ctx.ui.action` on an undeclared component name `permissions.ui.components` in the
  refusal. A UI arrangement entry of the wrong kind is refused with a message naming the slot and what
  it takes (`{ hidden, order }` on a list slot, `{ use }` with a contribution key or null on a single
  slot).
- 5d464ce: The client stylesheet rule is one function in the SDK: `clientCssProblem` (with `wrapClientCss`, the
  `@layer extensions` wrap the packer stores). `capybara-plugin pack` runs it on the file as it stores
  it and the kernel's import runs it on the stored bytes, so a plugin that packs cleanly imports
  cleanly: a broken `url(` fragment, a bad url token or a brace that would end the
  `@layer extensions` block early is refused at pack time (`client-css-remote`), not only at import.
  The packer no longer loads the kernel for this.
- 8c49d09: The shell element publishes `run=`, `theme=<plugin>/<file id>`, `motion=` and `sidebar=rail|full` in
  `data-cap-state`; the open conversation's log is turned into client events on the client (history
  loaded on open emits nothing). `ThemeRef` gains `key`.
- Updated dependencies [c4b4f6f]
- Updated dependencies [f172ba6]
- Updated dependencies [f2786a6]
- Updated dependencies [460567f]
- Updated dependencies [ec5f411]
- Updated dependencies [107a004]
- Updated dependencies [25e6ef3]
- Updated dependencies [e531e6d]
- Updated dependencies [5d464ce]
  - @capybara-hq/plugin-sdk@0.1.0-rc.11

## 0.1.0-rc.14

### Patch Changes

- 848fb39: Setup guides v2 kernel checks: `capybara:public-url`, `capybara:webhook-public`,
  `capybara:webhook-received` (the gateway marks an accepted webhook in Redis, at most once a minute
  per connection, kept 7 days), `capybara:connection-active`, `capybara:oauth-client`,
  `capybara:connector-tools`, `capybara:connector-connected` and `capybara:oauth-token-endpoint`, which
  probes the token endpoint with the stored client and a fixed invalid code (through the kernel's
  network rules, no redirects, nothing logged or stored). The guide route returns the guide's
  `template`; check runs need the connector's live platform template, read the cache again after
  taking the run lock, and redact the sent forms of a connector's credentials too.
- 2f01b01: Setup guides v2 checks: extensions register setup checks with `ctx.setup.check` (only during
  setup, ids from `permissions.setupChecks`, recorded in the permission snapshot without blocking
  loading). `GET …/catalog/:itemId/guides/:guideId/checks` reads the cached state of a guide's checks
  and `POST …/checks/:checkId/run` runs one (30 a minute per account): results cached in Redis per
  target, mode and (for member checks) account, single flight across replicas, a 10 s force cooldown,
  8 concurrent runs per org, a 10 s time limit, and every result validated, redacted by the target's
  and the extension's secrets and validated again. The `Platform` tool gains `setup.status` and
  `setup.check`. Guide acks of channel connections and connectors follow the guide read's catalog
  visibility.
- 155c1cf: Setup guides v2 for connector templates: the guide route renders a template's guide for the org's
  connector made from it (`connectorId`, `connectorName`), connectors created from a template record
  the guide they were set up with (`connectors.guide_ack`, migration 0106, which also clears the v1
  acks of channel connections), connector views carry `setupGuide` and `guideDrift`, and
  `POST /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack` confirms an updated app (409
  `connector.guide_changed`; a human-only Platform exclusion). Catalog template entries and the
  connector template list carry `guide`; the platform update preview lists `guideChanges` with org
  counts.
- 70a50f5: Complete the `Platform` tool's `setup` domain: `setup.guides` lists the setup guides a person may
  help with (targets, drift, cached check counts, web pages) and mirrors the new
  `GET /api/v1/orgs/:orgId/setup-guides` route; `setup.read` returns a guide rendered as Markdown
  (checks as `- [check <id>]` lines) and mirrors the org guide route, which is no longer excluded.
  Every setup operation is read class; secrets, OAuth consent and the guide ack stay human-only.
- 6622107: Setup guides v2: the kernel validates `guides/<id>.md` (and `.zh.md`) at import with the SDK
  validator, stores both documents as display files, and renders a guide per org, place, mode,
  audience, locale and target (`GET …/catalog/:itemId/guides/:guideId` now returns blocks, checks,
  unresolved variables with reasons and the v2 drift hash). Channel connection acks use the v2 hash;
  a version imported with a v1 `setupGuides` entry shows no guide. The super admin previews a guide
  with `GET /api/v1/admin/catalog/:itemId/guides/:guideId` (a Platform exclusion).
- Updated dependencies [70a50f5]
- Updated dependencies [aa81e5a]
- Updated dependencies [2219734]
  - @capybara-hq/plugin-sdk@0.1.0-rc.10

## 0.1.0-rc.13

### Minor Changes

- c12e7a7: Org admins and the super admin can hide and reorder extension contributions per UI slot: the org
  setting `uiArrangement` and the deployment setting `uiArrangement` (an org's entry replaces the
  platform's for that slot). Hidden means not listed: the contribution lists apply it, the view,
  action and embed routes do not. `GET /orgs/:orgId/ui/arrangement` and `GET /admin/ui/arrangement`
  list the slots with their items for the arrangement page.
  The lists are grouped by anchor in the slot's anchor order also for a slot no arrangement names.
- 17fdfb1: `GET /api/v1/ui/slots` lists the UI slot catalog for any signed-in person, and the Platform
  operation `ui.slots` (new `ui` domain) lets an agent read it.
- 0e765e2: The extension host resolves each UI contribution's slot once per load: a contribution to an unknown
  slot or slot version is dropped (the extension still loads), logged once, and listed as `uiDropped`
  on the admin extension view. Contributions still on the deprecated `place` load unchanged (info
  log). The contribution list no longer carries `legacyPlace`, and contributions to slots without a
  place (agent, org settings, platform) are not listed or served through the org routes yet.
  A file previewer whose embed names a dropped contribution is left out (one warn per load) instead
  of failing the extension.
- 18defa0: `platform.page` contributions are served to super admins on org-less routes under
  `/api/v1/admin/ui/` (`contributions`, `views/:plugin/:id`, `actions/:plugin/:id`,
  `embeds/:plugin/:id/token`, `stream`): the extension must be running (no org enablement applies)
  and gets the platform's deployment config. `UiRenderArgs` / `UiActionArgs` become unions narrowed
  on `scope`: the platform variant has `role: "superAdmin"` and no `orgId`. `EmbedClaims` gain
  `scope: "org" | "platform"` (`orgId` absent exactly for the platform scope); a platform token
  verifies only for a `platform.page` contribution while the account is still an active super admin,
  and an org token never verifies for one. `ctx.ui.invalidate` takes no `orgId` for a `platform.page`
  contribution (refreshing the admin console's stream) and throws when one is given.
- cf93278: The org UI routes gate every contribution by its slot: the slot's `minRole` (`org.settings.section`
  admin and above, `org.page` member and above, conversation and agent slots any member), then its
  scope (a readable conversation; an agent the caller can read in this org). `platform.page` is never
  listed or served through an org route. `GET /orgs/:orgId/ui/contributions` takes `?slot=` and lists
  `slot` and the resolved `after` anchor instead of `place`, ordered by extension name, then manifest
  order. Views, actions and embed tokens take `agentId` for `agent.detail.section`; embed claims carry
  it, and `ctx.ui.verifyEmbedToken` returns null when the current role no longer meets the slot's
  `minRole`. `UiRenderArgs` gains `slot`, `scope` and `agentId`; `EmbedClaims` gains `agentId`.

### Patch Changes

- 0a5b15d: One name: devices. Environments become devices everywhere in the kernel: migration 0105 renames the
  tables (`devices`, `device_instances`, `device_defaults`, `device_machines`), the `device_id` columns,
  indexes and constraints, turns `source` `device` into `local`, the provider `@device` into `@local`
  and the log event `environment_paths` into `device_paths`. Config `environments.*` becomes
  `devices.maxPersonal` and `devices.local.*` (`CAPYBARA_DEVICES__…`); error codes `environment.*`
  become `device.*` and the sign-in codes become `device_sign_in.*`; routes move to
  `orgs/:orgId/devices…`, Platform operations to `devices.*`, the IM command to `/device`, sandbox
  file systems to `cap-device-<id>` (existing cloud files under `cap-env-<id>` are left behind) and
  the sign-in `verificationUri` to `<web>/devices/link`.
  
  Upgrading: sandbox jobs queued by the previous kernel (instance destroys, file resets) are dropped
  (the hourly sweep still cleans deleted devices; a file reset must be requested again), and audit
  rows written before the upgrade keep their `environment.*` action names.
- 199f895: UI contributions name a slot (`slot: "conversation.panel"`, optionally `@<n>`, plus `after` for
  slots with anchors); `place` stays accepted as a deprecated input. `validateUiContributions` now
  covers only structural problems, and the new `resolveUiSlots` drops a contribution to an unknown
  slot or version instead of failing the extension. `normalizePlace` is removed.
- Updated dependencies [ec79610]
- Updated dependencies [d495d7d]
- Updated dependencies [18defa0]
- Updated dependencies [0a35407]
- Updated dependencies [cf93278]
- Updated dependencies [199f895]
  - @capybara-hq/plugin-sdk@0.1.0-rc.9

## 0.1.0-rc.12

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
- f60b796: `GET /orgs/:orgId/conversations/groups` gives each group's agent its avatar and profile time
  (`agent.profile: { avatar, updatedAt }`, the agents API's shape), and the sidebar draws the group
  titles from it: the agent's pixel avatar or image shows on every page, not only when the agents
  list happens to be cached; an agent without an avatar still shows its initial.

## 0.1.0-rc.11

### Minor Changes

- bbd508e: The admin component list gives each theme its name and swatches (`theme: { name, swatches }`), and
  an org's theme switch-off preview lists whether it is the org's default and how many members picked
  it (`preview.themes`), so the pickers and dialogs show them.
  
  An org owner's update preview names the orgs whose default a removed theme is (in `orgNames`) and
  counts only the owner org's own people in `pickedBy`.
- 00e742e: Serve themes: the public, immutable `GET /api/v1/themes/:id/:version/theme.css` (rendered from the
  stored theme, every value re-validated) and `…/assets/:file`, and the public
  `GET /api/v1/platform/theme`; new error code `theme.not_found`.
- b2b3faa: Plugin import, sync, update and removal carry themes: a plugin's `themes/*.json` (or
  `manifest.themes`) are parsed, readability-checked and their fonts and logos validated at import
  (refusals `theme.invalid` / `theme.unreadable`), synced as platform theme components with their
  sanitized assets under `deployment/platform/themes/<id>/<version>-<catalogVersion>/`, updated with
  their plugin and removed with it. Themes-only org uploads pass the custom content gate.
  A stored theme version holds only the theme file's own values (merged with the built-in tokens
  where they are used), and a catalog version is not judged for readability again on update or
  rollback, so a core token change neither blocks nor re-versions existing themes.
- f120273: Themes are components with scope, org switches and previews: theme ids are unique among the
  themes on in an org (`theme.id_taken`), previews of changes that take a theme away list the orgs
  whose default it is and how many people picked it, and changes that would take the platform
  default theme away from an org are refused (`theme.platform_default`).
- 2191e44: Which theme applies: the platform default (`uiTheme` in the deployment settings, a platform theme
  whose scope is `all`), the org default and personal lock (`theme` in the org settings) and the
  person's pick (`theme` in `PUT /api/v1/me/preferences`, which is now a partial update) are checked
  where they are set (`theme.not_available`). `GET /api/v1/orgs/:orgId/themes` lists the themes on in
  the org with swatches, the viewer's resolved theme and the org's setting; the Platform tool gains
  `themes.list` and the theme fields in its settings operations.
- c489ee6: Add storage for the `theme` component kind: `platform_themes` / `platform_theme_versions`, the
  `theme` kind in the component scope, switch and install component tables, and `accounts.theme`.

### Patch Changes

- Updated dependencies [c1c7b0f]
- Updated dependencies [ff5e3bf]
- Updated dependencies [00e742e]
- Updated dependencies [0158d0c]
  - @capybara-hq/plugin-sdk@0.1.0-rc.8

## 0.1.0-rc.10

### Minor Changes

- 5ec789c: IM time zone and language per person: channel@1 `InboundSender` gains optional `timeZone` (IANA)
  and `locale` (`zh` / `en` or a BCP 47 tag). The kernel records on an IM `user_message` the
  platform's zone (when valid), else the account setting, else the org default, and the platform's
  language (`zh` / `zh-*` Chinese, any other tag English), else the UI language of the person's most
  recent web message in the org, else the org's `locale`. Any message without a language uses the
  latest web language the same way, and run start falls back to the author's settings for a message
  from an older log. The fake channel's sender profile takes `timeZone` and `locale`.
- f74afee: Plugin setup guides: an import validates and stores a plugin's `setupGuides` template files with
  the version; `GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId?mode=&connectionId=&name=`
  renders a guide for the org (the catalog icon's visibility, `channels.manage` for a channel guide)
  with a fixed set of safe variables (`publicUrl`, `webhookUrl`, `signInCallbackUrl`,
  `connectionName`, `orgName`, `pluginName`, `pluginVersion`, `mode`; never a secret). Channel
  connections record the guide they were set up with (`guideAck`, migration 0099), carry
  `setupGuide` and `guideDrift` when an upgrade changed the templates of their mode, and
  `POST /api/v1/orgs/:orgId/channels/:connectionId/guide-ack { hash }` confirms the platform app was
  updated. `GET channels/schema/:plugin` gains `guide`.

### Patch Changes

- 6599de8: The bootstrap pins move to the jina and connector-openapi releases whose icons stay in color on dark
  backgrounds (capybara-hq/plugins#30).
- 2de4f26: The bootstrap plugins move to the releases that ship an icon (capybara-hq/plugins#27), and the
  marketplace pin follows that commit.
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
- Updated dependencies [09dea3e]
- Updated dependencies [c85f0b6]
- Updated dependencies [60ce217]
- Updated dependencies [3cbf6e8]
- Updated dependencies [5ec789c]
- Updated dependencies [2435645]
- Updated dependencies [ebe127f]
- Updated dependencies [d6fd4a9]
  - @capybara-hq/plugin-sdk@0.1.0-rc.7

## 0.1.0-rc.9

### Patch Changes

- fe7c389: Connected environments groundwork: `device` environments and the `environment_machines` table
  (migration 0093), the `environments.device` config section, and the `environment.offline`,
  `environment.program_outdated` and `device.*` error codes.
- cfc888b: Device sign-in for connected machines: `POST /api/v1/device/authorize` and `/token` (RFC 8628
  shape, public), the confirmation routes `GET /api/v1/device/pending/:userCode`,
  `POST /api/v1/device/confirm` and `/deny` (web session), per-machine `cap_dev_` credentials
  accepted only by the device connection, `DELETE /api/v1/orgs/:orgId/environments/:id/machine`,
  and deleting a device environment revokes its machine.
- 60fe3b6: The gateway role holds connected machines' WebSocket connections at `GET /device/connect`: the
  machine credential and protocol are checked before the upgrade, one connection per environment
  across replicas under a Redis lease (the newest connection wins), relayed requests are forwarded
  and results written back; revocation, takeover, lease loss and shutdown close the socket.
- af3c477: The `@device` sandbox provider: sandbox operations on a connected environment are relayed through
  Redis to the gateway replica holding the machine's connection, waiting up to the operation's
  deadline plus `environments.device.reconnectGraceSeconds`; registered on every role.
- ebbfeb5: Sandbox tools use the instance's real paths: `validateSandboxPath`, `skillSandboxDir`,
  `skillSandboxPath` and `renderSkillBody` take an optional instance root, `validateSandboxPathShape`
  checks a path without its roots, and device protocol roots must be clean absolute paths; the
  kernel builds every model-visible path from the held instance's roots, tool descriptions say "the
  workspace directory", and each conversation records its environment's directories in an
  `environment_paths` system line on its first sandbox call and whenever they change.
- Updated dependencies [c505b45]
- Updated dependencies [ebbfeb5]
  - @capybara-hq/plugin-sdk@0.1.0-rc.6

## 0.1.0-rc.8

### Patch Changes

- b98e6d1: Platform: `platform.preferences` and `platform.set-preferences` read and set your own time zone
  (mirroring `GET` / `PUT /api/v1/me/preferences`); the set is a personal, rememberable write.

## 0.1.0-rc.7

### Minor Changes

- fac6134: A builtin `CurrentTime` tool: the current local date-time with its UTC offset, the weekday, the time
  zone and the UTC instant. Without `timeZone` it uses the conversation's run context zone (else the
  org default, else UTC); an unknown zone is an actionable tool error. Read-only, allowed by default,
  and on for new agents with the other default builtins.
- 489ef01: Platform tool phase 2: the rest of the UI.
  
  - **Inbox and pending reads.** These cover:
    - your inbox and the platform inbox;
    - approvals waiting for you (summaries, never the call's input);
    - pending requests;
    - extensions waiting for permission confirmation (permissions, never config);
    - dismissing notices.
  
    Decisions stay on the web.
  - **Channels and org settings.** Channel connections are read without credentials (the webhook URL
    is included). An agent can change a channel's binding or remove it. Org settings can be read and
    changed, including the Platform tool switch, which applies from the next call.
  - **Evals.** Sets, cases, runs, labels and estimates are available as metadata and scores only.
    Case content and outputs stay on the web, and cases are labelled "case <n>".
  - **Connectors, agents and the rest.** Connectors can be refreshed and deleted. Agents can be
    deleted (never remembered) and have their versions read. A pending connector can be bound to an
    agent, and connector setup can be requested and its status read. Agent templates can be updated,
    shared and deleted. Background tasks can be listed and stopped (each stop is asked, never
    remembered). File previewers and model reads
    are covered too.
  - **Environments** (personal): list, read, create and rename. Delete and files reset are never
    remembered, and their cards warn that files are destroyed and that bound conversations lose their
    sandbox. The environment the conversation itself works in is refused.
  - **Agent skills and skill changes**: list and remove an agent's skills (shared agents are always
    asked) and list invocable skills. Skill changes can be read as a summary; deciding stays on the web.
  - **Prechecks** deny known failures before the card.
  - **Admin results.** Platform component writes name the orgs a component is on in and is named for.
    The platform inbox keeps the admin console's total when more than 100 items wait, and says how
    many of the newest it listed.
  - **Audit detail.** A write made through the Platform tool records
    `{ via: "agent", operation, agentConversationId, agentRunId }`, so the row's own `conversationId` /
    `runId` (an eval case's source run, for example) are no longer overwritten.
  - **Tool description.** The `Platform` tool's description names the current operation families.
    Its spec hash changes once, so remembered `Platform` grants and approvals pending at deploy are
    asked again (never wrongly allowed).
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
- 40c8ee0: Tools are on by default: an agent has every builtin, every tool of the extensions enabled in the
  org and every tool of the org's connectors, and its definition stores only what it turns off
  (`disabledTools`, replacing the enabled `tools` list; migration 0092 rewrites stored agents and
  org-made templates to "nothing turned off"). A newly added builtin reaches existing agents; a
  connector the org sets up is on for every agent; tools that cannot run now are left out quietly.
  The Platform tool's agent operations and `platform.me` use the new shape. `createAgent` in
  `@capybara-hq/testing` takes `disabledTools`; model-fake calls a tool on its own only when a
  request offers exactly one.

### Patch Changes

- 58dc1ae: Bootstrap preinstalls the native model platform providers `deepseek`, `bailian` (Alibaba Cloud Model
  Studio) and `ark` (Volcengine Ark) at 0.1.0-rc.0, off in every org until switched on; the official
  marketplace pin moves to capybara-hq/plugins d0cd2d17.
- e0f22ae: Platform tool: `agents.update-profile` sets an agent's preset avatar (or none) and its quick
  actions, confirmed like `agents.update` (rememberable only on your own private agent).
  `agents.update` takes the agent's description (saved with the definition), and `platform.me`
  returns the agent's profile. The last `later` exclusion is gone: the category is removed and
  `check:platform-ops` fails any `later` entry.
- 71858cf: An extension unloaded because a required extension point lost its provider re-reads its deployment
  config when the provider returns: it comes back on the config saved meanwhile, and stays pending
  configuration when its config was cleared, instead of returning on the old values and secrets.
- Updated dependencies [f31ec88]
  - @capybara-hq/plugin-sdk@0.1.0-rc.5

## 0.1.0-rc.6

### Minor Changes

- 4a92acb: Model kinds and display fields on `ModelInfo`, an optional `embed` on `ModelProvider`, `{ orgId, config }` call options, `validateEmbedResult`, and an `embedding` usage purpose whose conversation fields are optional.
  
  `ctx.models.embed` / `describe` for extensions that declare embedding purposes in
  `permissions.models` (no longer reserved): the kernel resolves the org's model for the purpose,
  splits batches by `maxBatch`, validates results, records a `model_usage` row per call and delivers
  it through `usage.report` with purpose `embedding`. Each batch is limited by the new hot config
  `models.embedTimeoutMs`; `embed` takes an optional per-call `signal`. `capybara-plugin check` reports `ctx.models`
  without `permissions.models` as `perm-models` (was `perm-reserved`).
  
  `ctx.models.embed` fires the `model.request` hook once per call, before anything is sent, so policy
  hooks (DLP) see the texts sent to embedding vendors. `ModelRequestHookPayload` is now a union:
  `ModelCallRequestHookPayload` (steps, compaction, titles, `WebFetch`; the former interface) or
  `EmbeddingRequestHookPayload` (`purpose: "embedding"`, `orgId`, `extension`, `embeddingPurpose`,
  `provider`, `model`, `input`, `dimensions?`, `inputType?`, no conversation fields); narrow on
  `purpose` before reading `request`. A policy denial rejects the call with the new error code
  `model.hook_denied` (403; an extension route that lets it escape answers 403, not 500), writes a
  `hook.denied` audit row and records no usage. `model.response` does not fire for embeddings.

### Patch Changes

- Updated dependencies [4a92acb]
  - @capybara-hq/plugin-sdk@0.1.0-rc.4

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
