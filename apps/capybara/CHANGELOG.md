# @capybara-hq/capybara

## 0.1.0-rc.142

### Patch Changes

- 0b25581: Pin bailian rc.15, deepseek rc.14 and openai-compatible rc.16: a `toolChoice: "none"` request (the
  in-context summary and the step-limit wrap-up) no longer drops the tool definitions on DashScope
  and DeepSeek, so it reads the conversation's prompt cache instead of rewriting it in full.
- 6992dd1: A `compaction` model purpose: a platform or org admin can map a cheaper summary model for
  compaction (kind `chat`); an unmapped or unusable mapping falls back to the conversation's model.
  With a compaction model, idle compaction gains a transcript mode that does not need a warm cache:
  it runs after `idleDelayMinutes` of inactivity (default 30). Cache mode keeps its timing from the
  cache and has no delay field.
  
  Data residency: with a compaction model, the conversation transcript is sent to that model's
  provider, not the conversation model's. Choose a provider the deployment may send it to.
  
  Measured transcript recall of the compaction model (idle spec quality gate, 20 seeded
  conversations): `qwen4-max` 97.1%, `qwen3.8-flash` 90.0%, `deepseek-flash` 87.5%,
  `claude-haiku-5-5` 81.3%, `deepseek-v4-pro` 80.4%, `claude-sonnet-5-5` 73.8%. OpenAI `gpt-5-nano`
  keeps only 19.6% (8/20 constraints) and is unsuitable as a compaction model.
- Updated dependencies [0b25581]
- Updated dependencies [6992dd1]
  - @capybara-hq/kernel@0.1.0-rc.115

## 0.1.0-rc.141

### Minor Changes

- 5743a33: Browser access to a granted loopback port: the kernel's loopback grants, the approval card for a
  local port and the patched sandbox proxy ship in the images.

### Patch Changes

- Updated dependencies [1f54362]
  - @capybara-hq/kernel@0.1.0-rc.114

## 0.1.0-rc.140

### Patch Changes

- c36595e: Acceptance rules move from the personal page `/account/automations` into a 接收规则 / Acceptance
  rules sheet on the automations page (`/automations?rules=1`), opened from the page head while a
  source directs events to you; acceptance automations carry the same tag in the list, and the
  rules' copy is neutral about the source.
- 9d1f819: A new conversation with a device project picked lists that project's skills in the `/` menu (as
  last read in one of your conversations, without asking the device), and its first message can
  invoke one; a bound conversation whose first run has not read the project yet does the same.
- Updated dependencies [9d1f819]
  - @capybara-hq/kernel@0.1.0-rc.113

## 0.1.0-rc.139

### Patch Changes

- 0cd9067: The process block's planning row draws the capybara at 21 × 15 (1.5 CSS px per art pixel),
  between the 28 × 20 that was too big and the 14 × 10 that was too small beside the rail's icons.

## 0.1.0-rc.138

### Patch Changes

- 277e995: The composer's `@` menu lists your own conversations under 会话, and a picked one is sent with the message as a referenced conversation and shown on the bubble as a link.
- 87d22ce: Light cards step toward the middle (layered shell rule 3): `panel` `#F9F8F5`, `panel-2` `#FBFAF8`,
  light `fail` `#C42E28`; menus, dialogs, sheets, the palette, tooltips and toasts sit on `raised`; a
  new `field` token (white in light, clear in dark) grounds inputs, selects, textareas, steppers, the
  segmented track and checkbox / radio boxes. The theme token report gains `field` and the new
  contrast and separation pairs. A theme scheme that recolours `panel` without naming `field` keeps
  clear fields (`themeSchemeFallbacks`, used by `mergeThemeSchemes` and the kernel's theme stylesheet).
- 23d3e04: `ctx.inbox.post` takes `title` and `body` as a single string or as `{ zh, en }` (like action
  labels); a bilingual text is stored as given (migration 0197) and the inbox, the push preview and
  the Platform tool's dismiss confirmation show it in the reader's language. The acceptance
  automation's prompt now states the mechanism for any directed event instead of "this work was
  assigned to you"; migration 0198 updates unedited acceptance prompts.
- Updated dependencies [45f62d4]
- Updated dependencies [87d22ce]
- Updated dependencies [23d3e04]
- Updated dependencies [b0a9f97]
  - @capybara-hq/kernel@0.1.0-rc.112

## 0.1.0-rc.137

### Patch Changes

- b43b201: A client component in `conversation.properties.section` that renders nothing (returns `null`)
  no longer leaves an empty titled section: the host draws the section only while the component
  renders a node, checked after every commit before paint. A component panel whose component
  renders nothing shows the panel's empty state instead of a blank pane. Design: `PropertySection`
  takes `hideWhenEmpty`, `RightPanel` takes `emptyText`.
- Updated dependencies [b217214]
- Updated dependencies [1f75908]
  - @capybara-hq/kernel@0.1.0-rc.111

## 0.1.0-rc.136

### Patch Changes

- bf47be9: Idle compaction: a conversation that goes quiet is compacted in the background from the prompt cache
  before the cache expires, so the next message neither waits for a compaction nor re-reads the long
  context at full price. Three settings (platform and org): `idleEnabled`, `idleMinTokensFloor` and
  `idleMinWindowRatio`; a person can opt out with a personal preference. It is on by default
  (`idleEnabled`), but it does not fire in the default config: it runs only where a model's cache
  lasts at least 30 minutes and its in-context summary is gated, which with the default
  `promptCache.longTtl: false` is no model today. Turning on the long cache tier (Sonnet, Qwen4-max)
  enables it and costs every cache write the long tier's price (Anthropic about 2× instead of 1.25× of
  input). Gating an OpenAI model waits for OpenAI credits.
- Updated dependencies [bf47be9]
  - @capybara-hq/kernel@0.1.0-rc.110

## 0.1.0-rc.135

### Patch Changes

- 14e987a: Directed events and acceptance (collaboration spec §4.4): an extension's directed event (work
  assigned to a member and their agent) follows the member's acceptance rule for its source, else
  the org's `automations.directedDefault` (default `auto`). `auto` makes the member's acceptance
  automation once (subject mode, no grants, asks the member on anything outside them) and runs the
  work; `confirm` posts a work offer to the member's inbox (accept runs it, decline tells whoever
  assigned it; an offer left unanswered for seven days expires and the trigger event sweep closes
  it); `off` runs nothing. Members set their rules on `/account/automations` (`GET`/`PUT
  automations/acceptance`, Platform operations `automations.acceptance-get`/`-set`); offers are
  accepted or declined only by the member on the web (`POST automations/offers/:id/accept|decline`).
  Directed events stored before this release are dispatched again by migration 0194.
- 0a86a3c: Add personal inbox items (collaboration spec §4.9). Extensions with `permissions.inbox` post
  items for one member with `ctx.inbox.post` (title, body, a link to their own `/p/<plugin>/` pages,
  up to three buttons naming their UI actions, an expiry, an optional dedupe key) and close them with
  `ctx.inbox.resolve`. The kernel stores them in `inbox_items` (migration 0192), lists them in the
  person's inbox only, calls a button's UI action as the person who clicks
  (`POST /orgs/:orgId/inbox/items/:id/actions/:actionId`) and resolves the item, or dismisses it
  (`POST …/dismiss`, also the Platform operation `inbox.item-dismiss`). New items push under the new
  category `inbox`. A trigger event stopped at the chain depth now posts a kernel item to the owner
  of the chain's last automation. The review shows `permissions.inbox` (blocking, not sensitive),
  `capybara-plugin check` reports `perm-inbox`, and the `fake-trigger-source` fixture gains
  `ctx.inbox` and an `org.page` view with a recording UI action.
  
  `ctx.triggers.causeOf(call)` returns a handle (24 hours, bound to the call's org and run and to the
  extension; table `trigger_cause_handles`, migration 0193) that a `ctx.queue` job passes as
  `emit({ cause: { handle } })`, so a queued event keeps the call's chain depth and self-trigger
  check. The trigger event sweep no longer flushes a window the dispatcher just opened, backs off
  re-owing a lost window and gives up after a day, deletes expired handles, and deletes inbox items
  closed or past their expiry more than `inbox.retentionDays` (new platform config, default 30) ago.
  
  `ctx.agents.usableBy`, `ctx.conversations.bySubject` and `ctx.people.get / search` give pages
  read-only org facts, each behind its own permission (`permissions.agents: { read: true }`,
  `permissions.conversations: { subjects: true }`, `permissions.people: { read: true }`; blocking,
  not sensitive). `usableBy` lists the agents an active member may use; `bySubject` returns the
  metadata (state from the latest run, never content) of the live conversations of the extension's
  own subjects; `people` returns members' names and avatars (at most 200 ids per `get`, `search`
  limit 50), never email. A call needs the extension enabled in the org (`CtxReadError`
  `org_disabled`). `capybara-plugin check` reports `perm-agents`, `perm-conversations` and
  `perm-people`.
- Updated dependencies [14e987a]
- Updated dependencies [0a86a3c]
- Updated dependencies [f1a8d71]
  - @capybara-hq/kernel@0.1.0-rc.109

## 0.1.0-rc.134

### Patch Changes

- 34d7dab: Composer menus phase B: the composer's top strip holds the device and project pickers (one
  「device / project」 sheet on phones, the project picker disabled while its projects load), the
  control row carries ＋, the mode menu, the model with its effort and send, and the @ menu lists
  library files (最近文件 / 匹配的文件) with 文件库 in the ＋ menu.

## 0.1.0-rc.133

### Patch Changes

- 73516ef: Pin the model provider plugins that declare prompt cache support (anthropic, ark, bailian,
  deepseek, openai, openai-compatible) and the plugins marketplace commit they were released from.
- Updated dependencies [73516ef]
  - @capybara-hq/kernel@0.1.0-rc.108

## 0.1.0-rc.132

### Patch Changes

- 4c7d149: File library: files belong to the person and conversations refer to them; bytes are per-org blobs
  deduplicated by sha256 and shared by files and shares (no more copies per share). A new Files page
  (`/files`, nav 文件) lists the person's uploads and agent deliveries with a preview, details,
  share, download, delete and upload; the conversation's file panel links to it. A daily blob sweep
  frees bytes nothing refers to (deleted files keep their bytes for `files.deletedRetentionDays`,
  default 30), and a one-off hashing job merges migrated duplicates. The Platform tool gains
  `files.list`, `files.get`, `files.usage`, `files.delete` (handoff to the Files page) and
  `files.add` (a conversation file into the library).
- efaf3e7: Compaction summaries reuse the prompt cache: every compaction first summarizes from the
  conversation's last request (its cached prefix) plus a summary instruction, for models that pass
  the in-context quality gate, and otherwise summarizes the transcript as before;
  `compaction_summary.method` records which path ran.
- 19b28a9: Org admins put plugin pages in the primary navigation: the sidebar and the compact drawer take
  `primaryExtensions` (after the built-in entries), the web places each page by the admin's saved
  choice, else the plugin's `nav` suggestion (at most 3 primary), and the organization settings get a
  Navigation page (导航) to choose. Component queries show their own error messages
  (`errors.ui.query_*`).
- 6332845: Full plugin pages contract: `ctx.ui.query`, the `usePluginQuery`, `usePageParams` and
  `useNavigate` hooks, `frame` / `nav` on `org.page` components, the `params` prop of `org.page`,
  new `UI_LIMITS` for queries and page params, and fake-host support in `/testing`.
  
  `@capybara-hq/plugin-client` forwards the page templates (`ListPage`, `DetailPage`, `FormPage`,
  `FormSection`, `SettingsPage`, `ActionRow`), data components (`DataTable`, `CellTitle`, `ItemList`,
  `ItemListItem`, `Markdown`, `EmptyState`, `Avatar`, `PersonName`, `FilterChip`), inputs (`Input`,
  `Textarea`, `Field`, `Tabs`, `Segmented`, `PrincipalPicker`), overlays (`Dialog`, `DangerConfirm`,
  `Sheet`, `Menu`, `Popover`) and `Board`, with behaving stand-ins in `/testing`; the web host
  prepends its scope crumbs to a forwarded template's `header.path`. The density of `Select`,
  `Input`, `Segmented` and `FilterChip` is typed as the design's own steps.
  
  The web renders full plugin pages: an `org.page` component with `frame: "page"` draws its page on
  `/p/<plugin>/<id>` without the host's DetailPage and must render exactly one forwarded template
  (dev and tests throw, production logs once); its params come from the query string (2 048 bytes),
  `useNavigate` changes them or opens another page of the plugin or a conversation, and
  `usePluginQuery` reads through the query cache, refetched on `ctx.ui.invalidate` and an action's
  `invalidate`. The host drops links in forwarded components other than same-origin paths and
  http(s) URLs. The contributions list names a component page's `frame`. The `/testing` DataTable
  stand-in draws `empty` / `noResults` and its `state`.
- 48e8860: Add the `promptCache.longTtl` setting to the platform and org settings.
- a5b4a02: Ask for the long prompt cache tier per request when `promptCache.longTtl` is on, record it in the
  model call and replay it with zero drift.
- Updated dependencies [d3e9ad6]
- Updated dependencies [5aaf693]
- Updated dependencies [efaf3e7]
- Updated dependencies [ca30a43]
- Updated dependencies [6332845]
- Updated dependencies [48e8860]
- Updated dependencies [a5b4a02]
  - @capybara-hq/kernel@0.1.0-rc.107

## 0.1.0-rc.131

### Patch Changes

- 5937a95: Scheduled tasks are renamed to automations in the kernel, with no change in behavior. Migration
  0188 renames the tables (`automations`, `automation_runs`, `automation_grants`) and rewrites the
  stored values that name the feature. The HTTP API moves to `/api/v1/orgs/:orgId/automations`, the
  builtin tools become `AutomationCreate`, `AutomationUpdate`, `AutomationList`,
  `AutomationTargets` and `AutomationDelete`, the Platform operations `automations.*`, the error
  codes and audit actions `automation.*`, the roles `automations.use` / `automations.manage`, the
  org settings group `automations`, the push category `automations` and the inbox kind
  `automation_attention`. The kernel config group `schedules.*` becomes `automations.*`: a
  deployment that sets `CAPYBARA_SCHEDULES__*` must rename those variables to
  `CAPYBARA_AUTOMATIONS__*`, and rename the `schedules` group in its config file and in Nacos too:
  the kernel refuses to start while the old key is present. Stop old replicas before migrating
  (0188 cannot run beside them); `sched-fire` and `sched-settle` jobs already in Redis are dropped
  and the ticks they carried are lost (pending runs settle when the automation next fires; a `once`
  automation may stay pending). See the upgrade guide.
- 92469e2: The composer's ＋, `/` and `@` menus replace the command palette, and 项目文件 references files of the
  conversation's device project as chips sent with the message.
- Updated dependencies [5937a95]
- Updated dependencies [92469e2]
- Updated dependencies [995fd1d]
- Updated dependencies [72d4c06]
  - @capybara-hq/kernel@0.1.0-rc.106

## 0.1.0-rc.130

### Patch Changes

- d05a120: A connector created from a template takes its default slug even when a loaded extension has the
  same name: re-creating the Slack connector is `slack` again, not `slack_2`. Connector tools are
  `mcp__<slug>__<tool>` and extension tools `plugin__<plugin>__<tool>`, so the names never meet; an
  explicit slug already worked this way.
- e0a95f0: Layered shell: from 600 up the sidebar and gutters sit on a ground and the page, the conversation
  and the right panel are paper on it (inset, rounded, no border or shadow), told apart by colour
  alone. The status bar is gone: the run state is announced to screen readers, round and elapsed
  time are in the properties panel's Context section, the context used is a small meter beside the
  composer's send button, and version and time zone are the account menu's last line. First-level
  pages draw no path row, the org switcher shows the org's name only, and the admin context is one
  row with its way back. Compact is unchanged.
- 252bdfa: A manual compaction (`/compact`) now summarizes every turn before the latest one, whatever
  `keepRecentTurns` says, and inside the latest turn keeps verbatim only the most recent tool pairs
  that fit about a fifth of the model's context window. It records `compaction_skipped` (reason
  `nothing_to_summarize`) only when nothing precedes the kept tail; the web divider reads "Nothing to
  compact · the conversation is still short". Automatic and reactive compaction are unchanged.
- a17f265: The `/` menu shows a project skill by its bare name, tagged "project" like a plugin's skill, and a
  typed `/<name>` no other skill has invokes the project's skill.
- 6c9f1d6: Native shells finish connector OAuth and login-method linking in the system browser: the connect
  and link starts take `handoff: { returnScheme? }` and answer a single-use handoff URL; the web page
  `/handoff/<ticket>` redeems it in the person's signed-in browser (`POST /api/v1/auth/handoffs/redeem`)
  and the flow comes back to `/handoff/done`, which links back into the app.
- 2fbe6d2: A watched wait (a tool watching something, such as a browser wait with a condition) reads 正在等待 / Waiting instead of "waiting for your answer".
- Updated dependencies [d05a120]
- Updated dependencies [252bdfa]
- Updated dependencies [6bab73b]
- Updated dependencies [6c9f1d6]
- Updated dependencies [2fbe6d2]
  - @capybara-hq/kernel@0.1.0-rc.105

## 0.1.0-rc.129

### Patch Changes

- c4311d1: After a run that failed or was stopped, the next request tells the model, at that run's place in
  history, that the run ended before it finished and why (a neutral category of the recorded reason,
  never the raw provider text; new `run_outcome_note` drift reason). The compaction summary's framing
  now says plainly that the earlier conversation was compacted into it. A manual compaction with
  nothing to summarize records `compaction_skipped`, and one whose model or attachment storage is
  unavailable records `compaction_failed`. The thread draws one divider per manual compaction and no
  run row for it (compacted, nothing to compact, failed, stopped), a divider for a person's model
  switch, and one line for a sub-agent that hands back a report and then finishes.
- Updated dependencies [c4311d1]
  - @capybara-hq/kernel@0.1.0-rc.104

## 0.1.0-rc.128

### Patch Changes

- a169b0f: Pin the model provider bootstrap plugins with the prompt-cache fixes (plugins#304): bailian
  0.1.0-rc.13 (the history is cached, not only the system prompt), ark 0.1.0-rc.14 and
  openai-compatible 0.1.0-rc.14 (implicit cache reported per model, a per-conversation
  `prompt_cache_key`, qwen dialect cache markers), openai 0.1.0-rc.14 (`prompt_cache_key` per org and
  system prompt); device-docker 0.1.0-rc.35 (docs only, listed at the same marketplace commit); and
  the plugins marketplace commit with the compose sandbox image build contexts to 87ca221.
- 3e0c357: The process block's planning row draws the capybara at 14 × 10 (one CSS pixel per art pixel),
  no larger than the rail's other marks; it no longer shows while calls of a parallel step are still
  queued, waiting or running (a sibling's result or an approval record ended the step too early);
  and a running `Platform` row names its operation instead of just "call".
- e948833: Live tool rows open by themselves: a streaming `Write` / `Edit` diff, an `Agent` prompt, a generic
  tool's input and a running call whose output grows show their detail without a click and follow
  its tail; when the call ends, a row the person never toggled folds back, a toggled row keeps the
  person's choice. Every tool detail box (finished and live diffs, outputs, the IN command and
  inputs, the trajectory view's IN / OUT blocks) is one compact viewport of about twelve lines that
  scrolls, with an expand control (展开 / 收起) to a tall cap when its content overflows.
- Updated dependencies [d7fd2a8]
- Updated dependencies [7e996c8]
- Updated dependencies [a169b0f]
- Updated dependencies [2f6bb23]
  - @capybara-hq/kernel@0.1.0-rc.103

## 0.1.0-rc.127

### Patch Changes

- f060da3: Conversation page polish: a sub-agent's input is labelled 提示词 / Prompt (no longer 任务, which
  reads as a background task) in its panel and in the agent map's detail, and the agent map detail's
  后台任务 section says 暂无后台任务 / No background tasks when opened with none.
- 3aad176: A model step cut off at the output token limit no longer ends the run as completed: request
  building tells the model right after the cut-off reply that it was truncated and an unfinished
  tool call did not run, and the run gets another step. After three truncated steps in a row the run
  ends with the new reason `max_output`; the web shows runs that ended at a limit with a warning
  instead of "Done" (#951).
- 06a0200: Pin the todo bootstrap plugin to 0.1.0-rc.15, which records the pinned card's badge (`card.badge`,
  plugins#293) so a finished process block head keeps its "待办 n/m" summary after a reload (#928), and
  device-local to 0.1.0-rc.13 (the version that commit lists), and the plugins marketplace commit with the compose sandbox image build context to ff7f845.
- 3c190bc: The conversation's process block reads calmly while a run is live: spinners only in the block's
  head and on each of several concurrent command rows, rail nodes keep their kind icon, a parallel
  command group says "Running 2 commands · 0 done", the head names commands by their description,
  live thinking shows its last three lines as rendered Markdown and collapses when it ends,
  narration renders its Markdown, Bash rows show only their description (the command and exit code
  move into the detail, a non-zero exit stays on the row), the planning capybara is the rail's last
  row instead of a line under the block, and the fold row's chevron lines up with the rail.
- Updated dependencies [3aad176]
- Updated dependencies [06a0200]
- Updated dependencies [803bcc4]
  - @capybara-hq/kernel@0.1.0-rc.102

## 0.1.0-rc.126

### Patch Changes

- 9615f3c: A streaming `Write` from a model that sends `content` before `file_path` now gets a live diff: the
  kernel guesses the file from the conversation's recent unchanged files, the row marks the path as a
  guess until the path confirms it, and a wrong guess is withdrawn at once. `Write`'s `file_path`
  description asks for the path first, and each streamed `Write` logs its input order.
- Updated dependencies [9615f3c]
  - @capybara-hq/kernel@0.1.0-rc.101

## 0.1.0-rc.125

### Patch Changes

- 7238964: Watched input waits (plugins#207, browser long waits spec): an extension tool's `InputRequired`
  may carry `watch: { deadlineMs }` and its registration a watcher (`ctx.tools.register(spec,
  handler, { watch })`, `ToolWatcher`). The kernel parks the run as a question (no model turns, no
  worker held) and polls the watcher every 10 s on the new `cap-kernel-tool-watch` queue; a settle
  wakes the question (new status and card state `woken`), and `ctx.resume.outcome` tells the handler
  how the round ended (`answered` / `woken` / `expired`). `ctx.deviceAccess.request` gains
  `ifRunning` (`DeviceAccessError` `not_running`), forced for watchers, which never resume or start
  anything. New config `tools.watchConcurrency` and `tools.maxWatchedWaitsPerAccount`; a watched
  wait skipped by a message reads `WAIT_SKIPPED_TEXT`; the web draws a wait card with one end button.
  The testing package gains the `fake-watch` fixture.
- 4ccde8f: Deleting a conversation now tells its device's services right away: the kernel owes a
  conversation-deleted notice in the deleting transaction and delivers it to every running extension
  service of the device (an offline device gets it once it is back; a stopped service once it runs
  again within the restore window). The SDK's device service protocol gains the notice
  (`encodeConversationDeleted`, `parseConversationDeleted`) and `DEVICE_SERVICE_RESTORE_MAX_AGE_MS`,
  the window within which a service may restore saved state. The browser plugin uses it to close a
  deleted conversation's tabs at once.
- Updated dependencies [7238964]
- Updated dependencies [18cce4b]
- Updated dependencies [4ccde8f]
  - @capybara-hq/kernel@0.1.0-rc.100

## 0.1.0-rc.124

### Patch Changes

- 77170f1: Marketplace manifest, archive and git downloads retry transient failures (a connection error or HTTP
  502 / 503 / 504, three tries with backoff) and their errors name the URL, the upstream status and, for
  a connection failure, the `net.httpsProxy` setting (core#886).
- 00a3e35: A sandboxed `Bash` result blocked at the address layer now carries one instruction about running
  outside the sandbox: the kernel's private-address network note replaces the trailing `[sandbox]`
  line when it says how to retry escalated (or why that is not possible), and the line keeps only its
  retry part when the note states just the fact; without a network note the line is unchanged.
  `Grep` and `Glob` also skip `.cache` directories while walking (a docker device's HOME is the
  workspace); a path passed explicitly is still searched.
- 47275d2: Bootstrap pins device-docker 0.1.0-rc.34 (plugins 1f142e1): an instance's egress proxy is replaced
  when its image id differs from the configured image's, so a rebuilt image under the same tag reaches
  existing instances on resume or next use.
- af68d0f: Pin the model provider bootstrap plugins that stream tool call input (anthropic 0.1.0-rc.11, openai
  0.1.0-rc.13, openai-compatible 0.1.0-rc.13, ark 0.1.0-rc.13, deepseek 0.1.0-rc.12, bailian 0.1.0-rc.12:
  `tool_call_start` / `tool_call_delta`, plugins#279), todo 0.1.0-rc.14 (pinned card, plugins#280) and the
  plugins marketplace commit with the compose sandbox image build context to 8a89f4b.
- 7dbb9b4: `ToolResult.card.badge` (pinned cards only, at most `CARD_BADGE_MAX` = 32 characters): the card's state as its view's badge, recorded on `tool_result.card` (display only). A finished process head shows the pinned summary ("Todos 3/5") after a reload from it, without reading the card's view. A running process head now times the run from `run_started` (its working time, waits for a person left out, as the status bar counts it) on the run's latest block only.
- d5675a5: The process block's rail is sectioned by the todo item that was current when each step ran (a
  done item's section starts closed), long rails mount only the rows near the viewport instead of
  paging 200 steps at a time, and a used or expired device code and an ended sub-agent wait fold
  into the rail as one line instead of staying below the block.
- 27547aa: Streaming tool rows show no key argument until the tool's path has parsed (a Write that streams its content first no longer shows the content), the process head follows a streaming call's label, and an Edit that is still writing `old_string` shows its size only.
- Updated dependencies [523c1fb]
- Updated dependencies [77170f1]
- Updated dependencies [00a3e35]
- Updated dependencies [47275d2]
- Updated dependencies [af68d0f]
- Updated dependencies [7dbb9b4]
  - @capybara-hq/kernel@0.1.0-rc.99

## 0.1.0-rc.123

### Patch Changes

- 7ff5147: The conversation thread draws a run's process as one block (conversation process blocks spec):
  thinking, narration and tool calls on a rail with kind icons, open while the run goes (its last
  four steps) and closed once it finishes, with the pinned todo card under the head; handoffs are one
  list of pending actions, then files and output cards, then the answer. Sub-agent transcripts and
  the sub-agent panel draw the same blocks.
- ace1b2b: Streaming tool input (spec 2026-11-26): the kernel forwards a provider's `tool_call_start` /
  `tool_call_delta` as display-only `tool_start` / `tool_input` stream deltas and keeps them in the live
  draft (`tools`, capped at 512 KiB per step); every stream event re-arms the idle watchdog, so a long
  tool call no longer times out. For a builtin `Write` over a file the conversation already read
  unchanged, the kernel reads a display-only base (`tool_base`) through a new `write_base` kernel read
  that never wakes a device. Tool info returns each tool's `inputView`. `@capybara-hq/testing` gains
  `checkToolStream` in the model conformance suite; model-fake streams every tool call's input and adds
  the `streamtool:<ms>:<name>:<json>` directive.
- 76af792: The conversation page shows a tool call while the model writes it (spec 2026-11-26): a streaming
  row (「生成中」 with lines and size) appears as soon as the call starts, `Write` streams as a live
  diff against the file's current content (or a numbered preview for a new or unread file), `Edit` as a
  live diff, `Bash` as its growing command, and the logged row replaces it in place.
- Updated dependencies [ba80ae7]
- Updated dependencies [ace1b2b]
  - @capybara-hq/kernel@0.1.0-rc.98

## 0.1.0-rc.122

### Patch Changes

- 6f19220: Step 3 of the runtime change for #907: `SANDBOX_RUNTIME_SOURCE.files` is the current
  `native-files.py` again (it answers `NOT_REGULAR_FILE` for a FIFO, device or other special file)
  and the staged copy is gone; `accepted` keeps the earlier helper's digest for one revision so
  device containers made from an earlier device-docker image stay available until they are
  recreated. The bootstrap manifest pins device-docker 0.1.0-rc.33 at plugins 5cb8d1f (the restaged
  image), the compose sandbox build contexts follow, and capybara-device's docker mode pins the
  sandbox image 0.1.0-rc.33.
- Updated dependencies [6f19220]
  - @capybara-hq/kernel@0.1.0-rc.97

## 0.1.0-rc.121

### Patch Changes

- bc6d7b1: A device provider's own `ToolError` answer is a definite outcome, not an unknown one (#903): a read
  (`readFile`, `stat`, `list`, `scan`) answered with any `ToolError`, and an effectful operation
  answered with an ordinary one (`kind: "error"`) on its first dispatch, complete their recorded
  intent with the failure and reach the model as the provider wrote them; the same identity replays
  that answer. A transport loss, an `unavailable` answer to an effectful operation and any answer to
  a reconciled effectful operation stay unknown. A background start answered with a `ToolError` is
  refused with the kernel's reason.
- Updated dependencies [bd6dd67]
- Updated dependencies [bc6d7b1]
  - @capybara-hq/kernel@0.1.0-rc.96

## 0.1.0-rc.120

### Patch Changes

- 98658ac: Pin the device-docker bootstrap plugin to 0.1.0-rc.31 (rebuilds a missing or stale egress proxy before use,
  reports and rolls its device services on new files, an empty /run no longer reads as an outdated image) and
  the plugins marketplace commit with the compose sandbox image build context to 2b69fe6 (sandbox images
  0.1.0-rc.31: ripgrep in the sandbox image, egress proxy refusals reported with their reasons).
- Updated dependencies [98658ac]
  - @capybara-hq/kernel@0.1.0-rc.95

## 0.1.0-rc.119

### Patch Changes

- 7c691af: `ctx.deviceAccess.ensureService` and `request` hand an extension the device and provider failures
  as the sandbox tools say them (an actionable `ToolError`: the provider cannot be reached, the
  machine is offline or needs an update, the outcome is unknown, ...), instead of the raw error that
  extensions could only report generically. A browser tool on a device whose provider is down now
  says what a Bash call says.
- 41d7498: Third-party sign-in is turned on, ordered and trusted in the admin console (Platform → Extensions →
  the login extension → Sign-in, and Platform → Settings → Login methods) or through the
  `login-sources.*` Platform operations. **Remove `CAPYBARA_AUTH__LOGIN_SOURCES` and
  `CAPYBARA_AUTH__TRUSTED_IDENTITY_SOURCES`** (`auth.loginSources` / `auth.trustedIdentitySources`):
  startup fails while either is set. Signing in with an unlinked external account now leads to a link
  page (username and password) instead of creating an account; self sign-up is opt-in per method.
- 7d032f0: `extensions.platform-config` lists the extension's platform setup guides (`guides`: id and title,
  in the optional `locale`) and, when a guide exists and the deployment config is invalid or leaves a
  required field without a value, a `next` step naming `extensions.platform-guides`. An agent reading
  the config now learns that the extension ships a setup guide instead of guessing the operation.
- e0a320f: Device service rolls (an extension upgraded while its service runs), follow-ups:
  `deviceServiceFilesDigest` caches per files object, and `DEVICE_SERVICE_FILES_DIGEST_VECTOR` pins the
  digest for every implementation (capybara-device now uses the SDK's). The kernel never rolls a
  service to the files of a draining instance, of another package than the replica runs or than the
  deployment enabled, and keeps a service that answers the new roll check (`DEVICE_SERVICE_ROLL_CHECK`,
  `parseRollCheck`, `isRollCheck`) busy. A provider that keeps the old files after the start is
  refused with the cause instead of every later call being reviewed again. The
  `device.service_started` audit row says `reason` (`start` or `files_changed`), the files digest and
  what a roll replaced, and a call that finds the row of the same start writes none.
  A busy answer holds a roll onto the same files for at most an hour, and the holds apply at the
  re-check after the review too.
- 5a8cd3b: The side panel's header drags the desktop window like the rest of the top edge.
- Updated dependencies [7c691af]
- Updated dependencies [f10820e]
- Updated dependencies [086129e]
- Updated dependencies [6984d37]
- Updated dependencies [7d032f0]
- Updated dependencies [e0a320f]
  - @capybara-hq/kernel@0.1.0-rc.94

## 0.1.0-rc.118

### Patch Changes

- 449d337: A device service keeps running after its extension is upgraded no longer: the provider reports the
  files a running service was started from (`DeviceServiceStatus.filesDigest`, the new
  `deviceServiceFilesDigest`), and `ctx.deviceAccess.ensureService` treats a service running other
  files like a stopped one: the start is reviewed, then the provider restarts it on the new files.
  capybara-device restarts a running service whose ensure names other files (its `filesDigest`, or
  the digest of the files sent) and reports the digest in its status. Providers that report no digest
  keep the old behaviour; device-local passes it through from its next release.
- 58a6a91: Pin the device-local bootstrap plugin to 0.1.0-rc.12 (reports the running service's files digest, so an
  extension upgrade restarts its device service; core#874) and the plugins marketplace commit with the
  compose sandbox image build context to a48ecd8.
- Updated dependencies [449d337]
- Updated dependencies [58a6a91]
  - @capybara-hq/kernel@0.1.0-rc.93

## 0.1.0-rc.117

### Patch Changes

- de210cf: Browser tabs owned per conversation, core part. `ToolCallContext.rootConversationId` gives every
  tool handler the root of its conversation tree (set by the kernel). A viewer stream on a device
  service now starts with a kernel-written viewer context message (`DeviceServiceViewerContext`,
  `encodeViewerContext`, `parseViewerContext`: the ticket's conversation and its root); a later
  `{"kind":"viewer"}` from the panel is never context. `ctx.deviceAccess.answerHandoff` takes
  `handoffConversationId` and answers a sub-agent's handoff from the root's panel, only within the
  scope conversation's tree. `@capybara-hq/testing`: `FakeDialInMachine.streamOpenGate` holds a
  `stream-open` answer for ordering tests. During a rolling upgrade, viewer tickets minted by an older
  replica are refused (a ticket lives 60 s; reopen the panel).
  The browser plugin's panel Done / Cancel needs the browser release that passes
  `handoffConversationId`; upgrade both together.
- 095e00b: Plugin embeds delegate Chrome's local network access permission: after a network change (VPN,
  hosts file, a proxy) leaves the app's page on a public connection while the embed's own requests
  reach the same host at a private address, Chrome now asks once instead of blanking the embed.
- 016a74a: Questions can be answered with buttons. `InputForm` gains `body` (longer text under a short title)
  and, on its single field, `choices` (labelled values). When that field is required and a single
  choice (a `boolean`, or a string `enum` without `multiSelect` / `allowOther`), it renders as one
  button per choice, the first primary, and pressing one answers at once. Examples are a confirm
  (完成 / 取消) and a one-value wait (结束等待). `validateInputForm` checks the rule, and the
  kernel keeps `body` and `choices` in `question_asked`. The conversation's question card shows the
  body. When the plugin tool's `InputRequired` names a panel (`open`), the card also offers an action
  that opens that panel.
- Updated dependencies [de210cf]
- Updated dependencies [016a74a]
  - @capybara-hq/kernel@0.1.0-rc.92

## 0.1.0-rc.116

### Patch Changes

- 2c09b84: Pin the bootstrap device providers to the releases that take namespaced device service ids (core#840):
  device-docker 0.1.0-rc.30 (services as their own user, pinned read-only Chromium in the sandbox image)
  and device-local 0.1.0-rc.11 (sealed service install directory, gone at once after a machine restart),
  plus the plugins marketplace commit and the compose sandbox image build context at 44fa9a1. The kernel
  and these providers move together: deploy them in one step, together with device-e2b 0.1.0-rc.30 and
  browser 0.1.0-rc.5 where installed, and capybara-device 0.1.0-rc.37 on machines.
- aa535be: Images in tool results reach the agent and the person. The pipeline stores every image block a
  tool returns (a browser screenshot, an MCP image) as a copy of the conversation and names it in the
  result (`file_id`); a model with vision sees it after the step's results, a model without vision is
  told it was not shown and how to read it, and an image that cannot be stored says why. The web
  shows the images as thumbnails on the call's row (opening the image viewer), and `Deliver` takes a
  `file_id` to hand such an image (or any attachment or artifact of the conversation) to the person
  without a device.
- Updated dependencies [2c09b84]
- Updated dependencies [e6a1fb9]
- Updated dependencies [aa535be]
  - @capybara-hq/kernel@0.1.0-rc.91

## 0.1.0-rc.115

### Patch Changes

- c9a563b: Device services are namespaced per extension (core#817): a device provider now receives every service
  by its id `<extension>.<name>` (`DEVICE_SERVICE_ID_RE`, `deviceServiceId`) in `ensureService`,
  `stopService`, `serviceStatus`, `serviceRequest` and `openStream`, never by the extension's bare name,
  so two extensions declaring the same service name never start, stop or reach each other's process.
  `ctx.deviceAccess` keeps the extension's own names and maps statuses back. `capybara-device` accepts
  service ids only (a machine on an older version refuses them: update it with the deployment), and the
  device service conformance starts `conformance.echo`.
- 5a8031d: Dial-in stream data can travel as binary WebSocket messages. A machine's hello offers `transport.binaryStreamData` and the kernel's `ready` agrees; from then on both sides send `stream-data` as one binary message (`encodeDialInStreamData`: tag, stream id, the raw bytes) instead of base64 inside JSON, which cuts a quarter of the bytes of every device stream (the browser live view). `capybara-device` offers it; a machine that does not offer it stays on JSON, and a `capybara-device` whose offer an older kernel refuses (4400 before `ready`) reconnects without it, so the device and the deployment can be upgraded in either order. `FakeDialInMachine` takes `binaryStreamData` to test both.
- 7a178bf: The conversation's right panel keeps an embed mounted across full mode: maximising or restoring
  the panel no longer reloads its iframe, so a panel's document and connections survive the switch,
  and a panel embed fills the panel (borderless) in both modes instead of sizing itself by `resize`.
  The embed bridge tells a `conversation.panel` embed the panel's mode: `EmbedParentMessage` gains
  `panel-mode { full }`, sent right after `init` and on every change, whoever made it (the embed's
  own ask, the close control or Esc, the host refusing full mode on a phone). A plugin tool's
  `InputRequired` may carry `open` (a `UiOpen` naming a `conversation.panel` of the same extension):
  the kernel writes it to `question_asked` after checking it, and the conversation page opens that
  panel when the question arrives.
- Updated dependencies [c245a0d]
- Updated dependencies [dd481a3]
- Updated dependencies [e2ca2ff]
- Updated dependencies [c9a563b]
- Updated dependencies [5a8031d]
- Updated dependencies [7a178bf]
  - @capybara-hq/kernel@0.1.0-rc.90

## 0.1.0-rc.114

### Patch Changes

- 04fb7d0: Pin the device-local bootstrap plugin to 0.1.0-rc.10 (a widened network applies in place, so the browser
  panel's allow restarts a running browser on the new network) and the plugins marketplace commit (with the
  compose sandbox image build context) to d03e463.
- Updated dependencies [04fb7d0]
  - @capybara-hq/kernel@0.1.0-rc.89

## 0.1.0-rc.113

### Patch Changes

- b210cae: A skill's 文件 tab is now a file browser: a tree of the version's files beside the shared file preview (Markdown, text and code, CSV, images through the web's built-ins, and `file-preview@1` previewers that take skill files), with SKILL.md selected by default, `?file=` / `?version=` in the address and 查看文件 on each version row; HTML and SVG files show as source text only. The kernel serves a skill version's file list and file bytes (checked against the manifest) for it.
- Updated dependencies [7e5299a]
- Updated dependencies [89099aa]
  - @capybara-hq/kernel@0.1.0-rc.88

## 0.1.0-rc.112

### Patch Changes

- de2b404: An embed in the conversation panel now fills the panel when the panel is maximised, instead of keeping its default height.
- 69e678d: Install, update, enable and the plugin pages show a plugin's contents through one view, cut by stage
  and audience: the description's first sentence with 完整说明, the license as a fact opening a dialog,
  connector templates whose host line opens their details, and the state each connector will be in
  after enabling. The platform update is one review page with change marks on the package's rows and
  an 更新后 section. The org enable page shows the plugin's description and its components'
  descriptions; the org plugin page lists the org's connectors from the plugin with their state and
  each member's own connection. The switch-off dialog groups what is removed, switched off and kept;
  a plugin without an extension or connector templates is switched on directly with an undo toast. An
  invalid plugin package lists its problems. Copy across these pages is plainer.

## 0.1.0-rc.111

### Patch Changes

- 684ec6e: Pin the device-docker bootstrap plugin to 0.1.0-rc.29 and device-local to 0.1.0-rc.9 (device services and
  streams for browser use), and the plugins marketplace commit (with the compose sandbox image build context)
  to 5aaf638, the release that also carries the browser plugin 0.1.0-rc.1.
- 4cd8780: The workspace skills page shows skills as cards with the plugin filter as a list scope, like the plugin market.
- 142ec7e: A marketplace source card shows a short state (OK, Failed) beside its name and the entry count and
  last refresh, or the error sentence, under it, so the name is no longer cut off. A list page that has
  both a source filter and field filters draws them on one row (the plugin market's 市场源 button sits
  after its source filter).
  An update through the import page shows the installed → staged versions in the review's chip for a
  plugin without an extension too (it read 安装 v<new>).
  The plugin market's card state names the installed version only (the 更新到 button carries the
  newer one), and a card's state takes at most half its head, cut with an ellipsis, so a long state
  never squeezes the name away.
  The plugin review follows the approved mockup: 完整说明 and 许可证全文 are one row of small links
  under the facts, a connector template is one row whose host line opens its description and full
  endpoint (no 端点详情 line), skills and agent templates open their texts from an inline link, and
  the dependencies lose their explanatory sentence. The design system gains `DisclosureLinks`.
- Updated dependencies [684ec6e]
  - @capybara-hq/kernel@0.1.0-rc.87

## 0.1.0-rc.110

### Patch Changes

- bace32a: `permissions.deviceAccess` is reviewed: each declared device service is a sensitive, blocking
  permission key (`permissions.deviceaccess:<service>`), so an extension declaring it, or an upgrade
  adding a service, waits for approval; the review lists the services in a "Device services" group.
  `capybara-plugin check` reports `ctx.deviceAccess` used without `permissions.deviceAccess`
  (`perm-device-access`).
- 612b262: `ctx.deviceAccess` works (browser use spec §7): an extension starts its declared device services in
  the conversation's device (a stopped service is launched only after the command review allowed the
  command as it runs, `env K=V … node <codeDir ?? stateDir>/<entry> …`: the entry in the service's
  code directory where the provider keeps code apart, the state directory as the working directory;
  the verdict is recorded with the tool call and a start is audited `device.service_started`; specs whose files or
  environment would escape the code directory or change what runs are refused), sends them requests,
  reports hosts the device's allowlist refused (an always-only network ask in the call's conversation,
  with the page's URL), mints single-use 60-second viewer tickets, adds hosts to the device allowlist
  (running services get the new limits) and answers its own tool call's handoff question. Every call
  is limited to the conversation's owner on their own personal device and to the services the
  extension declares. A `DeviceAccessError` an extension tool lets through reaches the model with its
  own message.
  `addNetworkHosts` takes exact host names only, as an approved network ask grants. A launch reviewed
  in a tool call round that then asks for input keeps its review record (and the hosts its service
  reported refused) for the call's result, which the resumed round writes.
- a66a83a: Network asks for extension service calls (browser use spec §7.1): hosts a device service reports
  refused during a tool call (the call scope) raise a network ask in the call's conversation, offering
  only "add to this device's list"; approving widens the device allowlist and runs the call again. The
  ask is recorded under the call's tool key; the web and IM cards name the agent's browser and say
  that open network mode stops the asks.
- c69d39b: An embed in the conversation's right panel may ask the host to maximise or restore the panel with a
  `panel-mode` bridge message.
- cee3e9a: The gateway role serves the device stream viewer `GET /device/stream?ticket=`: it takes the
  single-use viewer ticket, checks its record again, holds the device for the viewer's life and pipes
  the device service's stream to the browser (close codes 4401, 4404, 4409, 1001, 1012). A local
  device's viewer that reaches another gateway replica hops once to the replica holding the machine
  (`/internal/device-stream/<ticketId>`, authenticated with an HMAC under the master key). Opens and
  closes are audited (`browser.view`, `browser.view_closed`). Stream holds move the device's last use
  when taken, and a hold ending for a lifecycle change logs at debug.
  Viewer messages over 256 KiB, or ones the device stream cannot carry, close the viewer (1009);
  sockets are pinged and a socket paused for 30 s closes (1013); viewer upgrades are limited per
  client address (`device-stream-ip`, 120 a minute).
  The web tier's upgrade proxy sends the client address as `X-Forwarded-For` on `/device/stream`
  only, so the per-address viewer limit counts each client; a valid ticket refunds its attempt.
  An open viewer checks its record again every minute and closes when the access lapsed: 4401 (the
  extension switched off, the service no longer declared, the conversation deleted or its owner
  changed), 4404 when the device's provider is off in the org.
- 41a10bc: The web server forwards `/device/stream` WebSocket upgrades (browser live view) to the gateway, like
  `/device/connect`.
- b6acad0: `DEVICE_SERVICE_WORKSPACE_ENV` (`CAPYBARA_SERVICE_WORKSPACE`): providers set it for every device
  service to the device's workspace root, and services confine the files they take in and let out
  (uploads, downloads) to it. `DeviceServiceStatus` gains optional `codeDir`, the directory the entry
  runs from when the provider keeps code apart from state (absent: the state directory); the kernel's
  launch review shows `node <codeDir ?? stateDir>/<entry>`, still in the state directory.
- 2fa4887: Device services and stream holds in the kernel's SandboxService: `DeviceServices` starts, requests
  and stops a device's named service process through its provider, and `holdForStream` keeps a
  running device from idle suspension while a stream to it is open. The idle sweep is refused the device's lease while a stream hold is live (a viewer that opened
  after its first look is seen under the lease). Every `ifRunning` ensure sends the provider the
  name-only spec, and a service spec may not set `OPENSSL_CONF` or `OPENSSL_ENGINES` either.
- 6ab55eb: Dial-in device streams: `ctx.dialIn.openStream` opens a credit-controlled byte stream to a machine
  straight over its socket on the gateway replica holding it (`stream-open` / `stream-data` /
  `stream-credit` / `stream-close`, never through Redis or PG); another replica throws
  `DialInStreamElsewhereError`. The holder records its internal address under
  `capk:device-holder-addr:<deviceId>` next to its lease (new config `gateway.internalUrl`, default
  `http://<hostname>:<http.port>`). `FakeDialInMachine.onStream` serves streams in tests.
- Updated dependencies [bace32a]
- Updated dependencies [612b262]
- Updated dependencies [a66a83a]
- Updated dependencies [cee3e9a]
- Updated dependencies [b6acad0]
- Updated dependencies [2fa4887]
- Updated dependencies [6ab55eb]
  - @capybara-hq/kernel@0.1.0-rc.86

## 0.1.0-rc.109

### Patch Changes

- caf9873: Connectors can be created without listing their tools (`ConnectorsService.createDeferredIn`, for
  installs, scope syncs and upgrades): the row is written with no outbound call and the tool list
  follows through the outbox (`connector-tools-list` on the new `cap-connector-tools` queue, shown on
  the health overview). A `needs_config` connector gets the job when an org admin saves its missing
  input (its first OAuth client can now be saved on the connector), a personal one on a member's first
  credential; whoever writes the first snapshot (the job, a refresh, the drift scan) applies the
  template's default policies. A dcr connector created without a client registers it on the first
  connect, once across replicas. A connector the kernel creates has no creator (`created_by` nullable,
  shown as System on the admin pages). Agents get no tools from a `needs_config` connector, and the git gateway tells a member
  that an org admin must configure the connector instead of asking them to reconnect.
- 02f1b38: A platform plugin update creates the connectors of the templates it turns on (added ones, and ones
  no longer shipped off) in every org where the plugin is on and no connector from the template
  exists, inside the update's transaction and without an outbound call (builtin plugins excepted).
  A template whose connector plugin is not on in an org is deferred there: the update owes the org's
  template connector ensure, which creates it once the plugin is on. Its preview lists them per org
  (`connectorOrgs[].created` with display name and starting setup state, `connectorOrgs[].deferred`;
  `needsConfig` is gone) and names the orgs where the scope sync will try to install the plugin
  (`scopeInstalls`, `failing` with the last failure); all are part of `diffHash`. A template update that clears credentials and leaves a connector ready lists its tools
  again through the outbox.
- cd792a5: Installing, enabling and the scope sync of a plugin ask for no connector input: every connector
  template on in the org becomes a connector without an outbound call (its tool list follows through
  the outbox), one that needs an org credential or OAuth client waits as `needs_config` until an org
  admin configures it, a personal static one is ready for members to connect. The install and switch
  bodies no longer take `connectors`, `POST …/catalog/:itemId/connectors` and the Platform operation
  `plugins.configure-connectors` are gone, `plugins.install` asks for no secrets, and
  `plugins.set-enabled` switches on plugins with templates. The scope sync installs plugins with
  templates in every org; a plugin's own `needs_config` state comes only from an invalid effective
  extension config. An install's connectors take the first free name and slug, so an org connector
  of the same slug no longer blocks it. The import review gains each connector template's icon and
  the connectors each agent template needs.
- fd68429: Plugin pages are cards, and the marketplace sources page is cards with an add and edit dialog.
  Installing a plugin is two steps (choose the package, then review and confirm), and the review
  page shows less text: one sensitive total, config fields as chips, and what an update adds marked.
- 33d0490: The connector templates on in an org that the org never had a connector from (none live or
  deleted, none recorded on an install) now get their connector without input. This happens after an
  install commits and after an org switches an extension on (a `template-connectors-ensure` job on
  the new queue `cap-template-connectors`, retried while the connector extension is not loaded on
  the replica yet), when the scope sync adds a plugin's dependencies, and once at the first start
  after this release (under `lock:bootstrap`, skipped by a replica that does not get it, marked done
  in `deployment_settings`); a five-minute sweep (`template-connectors-sweep`, once per tick across
  replicas) catches what none of these re-trigger, such as a kind loaded after the queued ensure gave
  up or an always-on connector extension. A connector an admin deleted is never made again. During a rolling
  upgrade, replicas of the previous version neither owe nor consume these jobs: the startup pass of
  the first upgraded replica covers what was waiting, and jobs owed meanwhile wait in the outbox until
  an upgraded worker takes them. The first start after this release runs that reconciliation pass inside
  the start sequence, before the replica reports ready: on a large deployment (many orgs with
  installed plugins that have connector templates) that first start takes longer. The health overview lists the new queue ("Template connectors" /
  连接器模板补建). The dual-replica harness takes `beforeStart` to seed the fresh database before the
  replicas start.
- eab2d81: The web enables a plugin from one review page with 启用 and no input (the per-template steps and the
  补充配置 page are gone). A connector that lacks its org input shows 待配置 with 配置 for org admins
  (its 凭据 tab: the template's setup guide, the endpoint fields the template lets the org edit, the
  credential or OAuth client; saving records the guide) and 待管理员配置 for members; extensions whose
  config is invalid read the same way, and the agent page marks such connectors 待配置. The plugin
  review shows template icons and the connectors an agent template needs.
  The enable page lists what the package brings (its extension, skills, connector templates, agent
  templates and dependencies), and a plugin with an extension is reviewed there before it comes on.
  An installed plugin whose extension config is invalid reads 已启用 (the extensions page shows
  待配置). A connector template that is on without a connector says so, with 创建连接器 for org
  admins.
- Updated dependencies [d5aa819]
- Updated dependencies [caf9873]
- Updated dependencies [aa5b99c]
- Updated dependencies [02f1b38]
- Updated dependencies [cd792a5]
- Updated dependencies [ff6aeb8]
- Updated dependencies [33d0490]
  - @capybara-hq/kernel@0.1.0-rc.85

## 0.1.0-rc.108

### Patch Changes

- Updated dependencies [6730339]
- Updated dependencies [18b24bc]
  - @capybara-hq/kernel@0.1.0-rc.84

## 0.1.0-rc.107

### Patch Changes

- 0591382: A manual directory sync that cannot read the extension's state for the org (a transient failure
  such as a database error) now answers 503 `directory.unavailable` instead of 400
  `extension.config_invalid`; real configuration problems keep their 4xx (`extension.needs_config`,
  `directory.not_configured`). The skip reason of a scheduled sync is renamed from `config_invalid`
  to `state_unreadable`.
- Updated dependencies [0591382]
- Updated dependencies [c3475c6]
  - @capybara-hq/kernel@0.1.0-rc.83

## 0.1.0-rc.106

### Patch Changes

- 2a87cde: Bootstrap plugins are pinned to the plugins release built on the unified plugin config (core#720):
  every pinned extension is repacked without the removed `config.org` list, model providers and
  web tools read org-overridable fields per call, and `marketplace.commit` plus the compose sandbox
  build contexts move to plugins `1abf9e6`.
- f0e1138: Pin the device-docker bootstrap plugin to 0.1.0-rc.28 and the plugins marketplace commit (with the compose
  sandbox image build context) to 727f62b, the release that carries device-e2b's read-only `appliedNetwork`.
- Updated dependencies [2a87cde]
- Updated dependencies [f0e1138]
  - @capybara-hq/kernel@0.1.0-rc.82

## 0.1.0-rc.105

### Patch Changes

- 76f58f0: A background Bash start the kernel sent but could not confirm (a transport loss) no longer shows as
  failed in the thread while the kernel reconciles it. Its result keeps the same error text for the
  model and adds the display-only `launch_unconfirmed` view; the background tasks list gains
  `starting`, and reconciling a start announces `changed: background`. The row reads "正在确认是否已启动"
  / "Confirming whether it started" until the task is confirmed running or ends, and becomes a
  failed row only when the launch is given up, revoked or refused (#790).
- 43eb3a1: RLS phase 2 (issue #115): the kernel carries an org scope from its entry points (org guard, super
  admin routes, extension routes, jobs, cron ticks, run claims, channel and dial-in events, the start
  sequence, CLI commands) and, with the new `db.rls` config (`off` by default, `scoped`, `enforce`),
  sets it on every PostgreSQL connection. No behaviour change while `db.rls` is `off`.
- Updated dependencies [76f58f0]
- Updated dependencies [af84f8c]
- Updated dependencies [3efbc4b]
- Updated dependencies [43eb3a1]
- Updated dependencies [c7b4dcf]
  - @capybara-hq/kernel@0.1.0-rc.81

## 0.1.0-rc.104

### Patch Changes

- ab71de9: The plugin enable wizard opens on a 选择连接器 / "Choose connectors" step when the plugin has more
  than one connector template or a default-off one: every template with its icon, name, description
  and a mark saying what its step needs (nothing, an OAuth client, an address, a credential). Default-on
  templates start checked, default-off ones unchecked, one the org already has a connector for is kept
  (locked on); only checked templates get a step and a connector. The org install body
  (`PUT …/catalog/:itemId/switch` inputs, `POST …/catalog/:itemId/install`) takes `templatesOn`: the
  template ids to switch on with the install; the plugin's other templates are switched off in the org
  (audited `component.org_switched`) and stay available on /connectors. Unknown, disabled or not offered
  ids are refused (`validation_failed` at `templatesOn`); absent keeps the templates on in the org now.
  The Platform operation `plugins.install` takes `templatesOn` too. The design `CheckList` row takes an
  optional `mark` (a 24 px mark tile before the name).
- Updated dependencies [36738ec]
- Updated dependencies [ab71de9]
  - @capybara-hq/kernel@0.1.0-rc.80

## 0.1.0-rc.103

### Patch Changes

- b22a19d: Connector template descriptions in zh and en: component lists, the install wizard's templates
  (`OrgCatalogTemplate`) and the import review (`PluginReviewTemplate`) carry `descriptionZh` next to
  `description` (null when the template has one text). Connectors made from a platform template return that template's description
  (`templateDescription`, `templateDescriptionZh`; its current version, under the same visibility
  gate as its icon; null for a custom connector). A connector may also carry its own description
  (`description`, migration 0181 `connectors.description`, plain text up to 1024 characters): org
  admins set it in the create body or by PATCH (null or blank clears it; audited in
  `connector.updated`), and the Platform operations `connectors.create` / `connectors.update` take it
  too. The web shows the own description, else the template's in the page language, on the connector
  cards of /connectors and at the top of the connector's detail page; the add-connector wizard and the
  connector's 设置 tab edit it (the template's text as the placeholder). Template cards, the admin
  template page, the plugin page and the install wizard pick the text for the page language too.
- efdeb87: Rename the deployment config key `marketplaces.allowPrivateHosts` to `net.allowPrivateHosts`
  (environment variable `CAPYBARA_NET__ALLOW_PRIVATE_HOSTS`, was
  `CAPYBARA_MARKETPLACES__ALLOW_PRIVATE_HOSTS`). It is the one list of internal hosts for every
  outbound request the kernel resolves itself (marketplace, archive and git downloads, npm registry
  downloads, OAuth discovery, registration and token requests, git identity), so it now sits next to
  `net.httpsProxy` and `net.noProxy`. Refusal hints and the web's download error name the new key.
  A config file that still sets `marketplaces.allowPrivateHosts` fails startup as an unknown key:
  move the list to `net.allowPrivateHosts`.
- 855e6d9: The conversation's properties panel reads more calmly: the Context section lays out labeled rows
  (model, device with its mark under it, connectors, last run, total with sub-agents) instead of
  dot-joined lines, and the last run no longer repeats the model when it is the current one. A
  property section can carry a hint behind an info button with a tooltip (Background tasks' note on
  the permissions running work keeps moves there). The right panel can be narrowed to 360 (was 520).
  The client API forwards the design system's `Switch` (`checked`, `onChange`, `label`, `disabled`),
  with a `role="switch"` stand-in in `@capybara-hq/plugin-client/testing`.
- Updated dependencies [b22a19d]
- Updated dependencies [efdeb87]
- Updated dependencies [2b2b48c]
  - @capybara-hq/kernel@0.1.0-rc.79

## 0.1.0-rc.102

### Patch Changes

- ff74e46: The bootstrap step retries each npm package download (registry lookup and tarball) up to three
  times with backoff when it fails transiently (a dropped connection, a timeout, HTTP 408 / 429 /
  5xx), never on a 404 or a package that differs from its pin; the final error still names the
  plugin. Docker Compose upgrades now run `docker compose run --rm init` before `docker compose up
  -d`, so a failing migration or bootstrap no longer takes the serving containers down.
- c0dc748: `openai-compatible` is an optional bootstrap preinstall, no longer required: only `object-store-s3`,
  `skills-core` and `file-preview` are fixed in every org. On an existing deployment the
  demoted plugin keeps scope `all`: the bootstrap owes its scope sync, which installs it in every org
  that has not switched it off, so it stays on there.
- c55f359: The kernel drops the org-only extension config: an org's config of an extension is its copy of the
  overridable deployment fields. `PUT /orgs/:orgId/extensions/:extension` takes `{ enabled, force,
  confirm }` only, the org extension view loses `config`, `secrets` and `orgConfigSchema`
  (`configurable` now means "has an overridable field", `needsConfig` comes from the effective config
  alone), the install body loses `extensionConfig`, `extension.no_org_config` and the
  `extensions.set-org-config` operation are gone, and point providers, directory sync, web tools and
  setup checks get the org's effective config only. Deployment fields are org-overridable by default
  (`platformOnly` marks the rest). The testing fixtures move their org fields into `deployment`
  (fake-web's `token`, fake-im's `directoryUrl`) and mark the fixtures of points without org config
  platform-only. `plugins.set-enabled` switches a plugin on whose
  extension still needs the org's config (as the web does) and says so in `configNeeded`. A
  `platformOnly` mark below a top-level key (a hand-made package) makes that whole key platform-only,
  and a pipe or transform deployment root is read through to its input object.
  
  A config field's meta is merged across its default / optional / nullable / prefault / catch /
  readonly wrappers, and `secret` counts on any of them: a mark on a wrapper
  (`platformOnly(secret(x).optional())`) no longer hides the secret below it, which made the load
  fail as an unreachable secret.
- 1ae08aa: Load installed plugins packed before core#720 again: the reviewed static manifest stored with
  their install record still lists `config.org`, which the module's manifest no longer has, so every
  such plugin was refused with `manifest_mismatch`. The legacy list is dropped before the comparison.
  With the SDK's temporary `orgAccess` no-op and `defineExtension` dropping `config.org` (same
  release), modules such as deepseek, jina, ark, bailian, lark and slack import and load again; their
  org-only fields reach no permission set or view. Removed in core#720 plan Task 17.
- 6c2a7da: The model purposes pages (`/admin/models` and `/settings/models`, tab 用途默认) draw each purpose as
  its own section: the label, 已覆盖 and its one line in the head, warnings and the model select in
  the card, and the model's parameters folded in a disclosure (closed by default, its summary counts
  the customized parameters, a parameter error opens it).
- 2c45b54: An approval asked by a member's own tool policy no longer fails to record (`approval_requested`
  now takes `policy: "member"`). The web's API types now match the kernel routes they call
  (checked by `check:web-api-parity`): plugins with themes, an org's upload awaiting confirmation,
  migration-warning permissions, network grant refusals and skipped questions are typed and labeled,
  the account avatar upload no longer sends a field the route refuses, and an agent avatar of another
  image type is refused before the upload.
- 93ecec3: The web app has one org config form per extension: the overridable deployment fields (following
  the platform or the org's own copy). The org-config section, Save and enable and the install
  wizard's extension step are gone, and the platform's config form tags each field `Platform only`
  or `Org can override`.
- fb58f12: In the conversation thread, a tool call that returned an error shows a small red dot (named "The
  call returned an error" for screen readers and as a tooltip) instead of the red word "Failed", and
  a group header shows the dot and the count instead of " (N failed)". The error text stays visible.
- Updated dependencies [ff74e46]
- Updated dependencies [c0dc748]
- Updated dependencies [8bdbb9b]
- Updated dependencies [c55f359]
- Updated dependencies [1ae08aa]
- Updated dependencies [2c45b54]
  - @capybara-hq/kernel@0.1.0-rc.78

## 0.1.0-rc.101

### Patch Changes

- b0b933c: Connector templates and the connectors made from them show the template's own icon (for example
  Gmail, Drive and Calendar of one Google plugin) instead of their plugin's icon; a template without
  an icon of its own still shows its plugin's. The plugin install wizard lists the connector
  templates with their icons. A connector's icon is served on its own route, so guests, who see the
  connector pages but not the catalog, can load it too. New routes:
  `GET /api/v1/orgs/:orgId/connector-templates/:templateId/icon`,
  `GET /api/v1/admin/catalog/connector-templates/:templateId/icon` and
  `GET /api/v1/orgs/:orgId/connectors/:connectorId/icon`.
- 019b6ed: Marketplace labels: the official marketplace is named "Capybara" (it was "Official marketplace" /
  "官方市场"), and a marketplace managed by the deployment config (an extra bootstrap manifest)
  shows the `owner.name` of its marketplace.json once a refresh has read it, instead of its config
  key. The config key stays the row's name, its id (`config:<name>`) and its token's env name.
- 4c1002a: `SANDBOX_RUNTIME_SOURCE.files` is now the Linux launcher with exact file read roots (the
  `current` of core#742; `current` and `files` are the same again), and `accepted` keeps the earlier
  launcher's digest for one revision so device containers made from an earlier device-docker image
  stay available until they are recreated. The image pins device-docker rc.25 (its image stages the
  new launcher and checks staged files against `accepted`) and device-local rc.7, at plugins commit
  03a53c8.

## 0.1.0-rc.100

### Patch Changes

- 4e207e4: The bootstrap step now moves the platform version of a pinned plugin with an extension along with
  its extension: once the extension runs the raised pin, a platform version that came from the
  bootstrap and is lower is applied through the platform plugin update, so the plugin's skills,
  connector templates, themes and org installs follow it. A platform version the super admin moved to
  is kept, a disabled plugin is left for the super admin, and a platform an earlier run left behind
  is caught up.
- 9abdccd: The image pins device-local rc.6 and device-docker rc.24: each device report says how to change
  its limits, and device-local names the owner's ceiling as the limit when it applies.
- b4c0d80: `Skill` on a project skill whose recorded root makes no clean absolute SKILL.md path now names that
  cause instead of claiming the path is outside what the device can read in sandbox mode.
- Updated dependencies [4e207e4]
- Updated dependencies [b4c0d80]
  - @capybara-hq/kernel@0.1.0-rc.77

## 0.1.0-rc.99

### Patch Changes

- c6d4a02: The bootstrap step now raises a pinned plugin without an extension (a theme, skills or connector
  templates) like one with an extension: when its platform version came from the bootstrap and is
  lower than the pin, the pinned version is imported and applied through the platform plugin update
  (`upgraded`). A version the super admin moved to (another source or a higher version) is kept, and
  the run reports the version actually in place instead of the pin.
- 61e77a7: The new conversation's device picker no longer opens an empty list: with no device but a device
  provider on, it reads "No device" and offers only New device (the Devices page's dialog); with no
  way to create one it is gone. The org Models page shows a locked model service's state on a
  disabled switch, as the Extensions page does.
- 99a2c5b: Deleting a device whose provider plugin is no longer installed no longer retries forever: the
  instance is marked abandoned (migration 0180), its provider-side names are kept on the row and in
  a `device.instance_abandoned` platform audit event, and the destroy job finishes.
- e71a6c5: A device report's limit value is text now: `DeviceReportLimit.value` is `DeviceText`
  (`{ en, zh? }`, at most 60 characters per language, checked by `parseDeviceReport`) instead of a
  string, so a provider can translate words in it; a string value no longer passes. Migration 0179
  turns the string values of stored reports into `{ en }`, and the device page shows each value in
  the UI language.
- ae21a49: Settings → Models gives each model service the Extensions page's on / off switch, so org admins can
  switch a service off there too, including one the platform turns on by default (scope `all`), which
  keeps its "on by platform default" state beside the switch. Locked services (platform-wide, not
  switchable, unavailable, or waiting for config while off) keep their state with no switch.
- 8e9fe85: Org readiness agrees with the agent form: the model step is ready only when the org has a chat
  model an agent can pick (the same cached lists and time limit as the agent form's model list).
  Providers that are on but give no model make the new state `no_models`, with each provider and
  why (its list failed, with the error kind such as `auth`, or it has no chat model on in the org).
  The setup checklist names the provider and the problem and links to `/admin/models` or
  `/settings/models`; the agent form says the configured model services list no usable model
  instead of asking to install a provider.
- 7cbe0e2: The kernel's legacy sandbox route is gone: `SandboxService.withSandbox`, the protocol-2 held
  provider, the builtin tools' legacy entry and `device_paths` writer, and the
  `PERMISSION_CONTEXT_ACTIVATION` test seam with every dormant branch behind it. Every use of the
  instance through the sandbox service's use entry is an operation invocation, a trusted preparation
  or a kernel read. Production already took only
  these routes, so nothing changes for a deployment; `device_paths` events already in logs still
  render and replay as before.
- Updated dependencies [c6d4a02]
- Updated dependencies [99a2c5b]
- Updated dependencies [e71a6c5]
- Updated dependencies [8e9fe85]
- Updated dependencies [7cbe0e2]
  - @capybara-hq/kernel@0.1.0-rc.76

## 0.1.0-rc.98

### Patch Changes

- d0fbb13: Kernel device follow-ups: adding hosts to a device's list from a network approval asserts every
  authority lock of its prelude, not only the device's; a failed project list never shows the
  machine's own error text; the test-only `DialInMachines.revoke` is gone. A network ask decision
  the device refuses (its network closed, it follows the org's hosts, or the host is no longer
  addable) names the reason, and the web says what changed and what the person can do.
- 1365ca1: The devices page holds the New device action's place with a placeholder while the list loads, so
  the button no longer pops into the header after load.
- f3dbb74: The kernel never proposes a sandbox approval for the new device deny entries (mise's config
  directory and home config files, Maven and Gradle credential files): it reads them from
  `DEVICE_DENIED_SECRET_PATHS` in the plugin SDK.
- 91346a7: The image pins device-local rc.4 (`@capybara-hq/plugin-device-local@0.1.0-rc.4`): an unreadable or
  too-long shared project root list keeps the stored roots, the limits text tries shorter roots, and
  the "+N more" suffix no longer shows English in the zh UI.
- 7e42a47: The image pins device-local rc.5 (`@capybara-hq/plugin-device-local@0.1.0-rc.5`): the connect guide
  names the device in its commands (`-c <device id>`) and no longer mentions the desktop app.
- Updated dependencies [d68c9fc]
- Updated dependencies [ef9ac57]
  - @capybara-hq/kernel@0.1.0-rc.75

## 0.1.0-rc.97

### Patch Changes

- 479c8a2: The composer's options sheet shows the model as one row that drills into a model page inside the
  sheet (spec §6.59 "In-sheet drill-in"): above eight models a search field (model and provider
  names), the current and the agent's default model first, a pick goes back to the options. The wide
  model menu gets the same search and pinned group. `BottomSheetContent` takes `page` and `back`,
  `SheetGroup` a visible `heading`, `SheetOption` a `tag` and a badge, `PickerItem` `pinned`.

## 0.1.0-rc.96

### Patch Changes

- a448d91: Bootstrap contract (migration 0178): a recorded run counts as done only while the latest completed
  run has the same extra-manifest part, so an extra manifest added back after its removal runs again
  and restores `required` / `builtin` (#534). A run records itself as started before its first write
  (`bootstrap_run_started`, with its extra entries), so a process without
  `CAPYBARA_BOOTSTRAP__EXTRA_MANIFEST` is refused from the first pass of an npm-only extra manifest on
  (#533). `BootstrapService.isDone` takes the manifest instead of its sha256.
- 7190039: Web: a native form post's same-origin check compares the Origin with the host the CSP names
  (a valid `X-Forwarded-Host`, else `Host`), so both agree behind a proxy other than server.mjs.
- a284fac: A device provider that finds its instance gone before a managed operation reached the machine
  throws `DeviceRequestNotSentError` with the `SandboxGoneError` as its `cause`: the operation is
  recorded as not started (the model is told nothing ran and may retry) instead of an unknown
  outcome, and the kernel rebuilds the instance at once so the retry runs on it.
- 8f225e9: The image pins device-docker rc.23 (`@capybara-hq/plugin-device-docker@0.1.0-rc.23`): the provider's
  own scripts run on a root-owned system PATH, so a tool planted in a writable PATH directory can no
  longer lift the in-sandbox time limit or run as root (capybara-hq/plugins#106).
- f770795: `capybara secrets rewrap` also rewraps unexpired sealed approval inputs (`platform_sealed_inputs`),
  so a resumed Platform call still reads them after the old master key is removed, and prints their
  count.
- 6aa42a6: Setup guides: a `connector-template` guide names one or more templates (`templates: string[]`,
  replacing `template`; a template still has at most one guide), so one guide can serve several
  templates of a plugin. `{{templateId}}` / `{{templateName}}` render the template the guide is shown
  for: the target connector's, the new `templateId` query parameter of the guide routes, or the
  guide's only template (else unresolved with reason `no_template`). The `extension-deployment`
  place now offers `{{signInCallbackUrl}}` (`<publicUrl>/api/v1/auth/sso/<plugin>/callback`), built
  from the same path constant as the SSO flow's redirect URI. `capybara-plugin pack` / `check` refuse a guide naming
  a scanned template the plugin lacks.
- e44ecab: Toasts: a touch swipe up dismisses on compact, a swipe down from 600 wide as before.
- f99d11c: `ToolCallContext.idempotencyKey`: the key of one logical tool call (64 lowercase hex, derived from
  the conversation, the run and the call id), the same across every `InputRequired` round of the
  call. A tool with an external side effect passes it downstream (for example as an
  `Idempotency-Key` header). The SDK docs now state that a call id is unique only within its run and
  that the kernel never retries a call whose result is unknown.
- Updated dependencies [a448d91]
- Updated dependencies [d837927]
- Updated dependencies [6aa42a6]
  - @capybara-hq/kernel@0.1.0-rc.74

## 0.1.0-rc.95

### Patch Changes

- 3284d6a: The image pins device-local rc.3 (`@capybara-hq/plugin-device-local@0.1.0-rc.3`): shows project
  directories shared with another connection.

## 0.1.0-rc.94

### Patch Changes

- 827062e: One device page for every provider (概览 / 网络 / 项目, provider origin on the nameplate), 新建设备
  offers the org's providers with their connection guides, and a network ask can add its hosts to
  the device's own list, with the moment that takes effect shown on the card.
- 7a5b3da: The image pins `device-local` `@capybara-hq/plugin-device-local@0.1.0-rc.2` (device protocol 6:
  per-connection project reach and coded project refusals) as the bootstrap preinstall with scope
  `all`, and the device-docker build contexts move to the plugins commit that lists it. Upgrade
  `capybara-device` to 0.1.0-rc.29 or later together with the kernel.

## 0.1.0-rc.93

### Patch Changes

- Updated dependencies [87ddef5]
  - @capybara-hq/kernel@0.1.0-rc.73

## 0.1.0-rc.92

### Patch Changes

- 5bbe04b: Back on compact no longer traps the person on a section's first page. Without an in-app history
  entry behind the page, back went to the last linked path segment, which on `/account/profile`
  (and `/settings/organization`) is the page itself: a link to the same address replaces the entry
  and changes nothing, so back never left. Back now skips a segment that links to the current page.
  
  Settings sub-nav items and link tabs are sibling views of one page: switching between them now
  replaces the history entry instead of pushing one, so back leaves the page rather than retracing
  every switch. `LinkComponent` takes an optional `replace`.
- 6a50bf4: Compact: the quick-return bar (and the settings sub-nav) docks right under the top row again
  instead of leaving a row-high gap the list shows through; a toast no longer stops the desktop top
  row from dragging the window; toasts on compact sit at the top under the top row, slide down and
  are dismissed by a swipe up (maintainer decision 2026-11-23).
- d0e209d: The image pins `device-local` (`@capybara-hq/plugin-device-local@0.1.0-rc.1`) as a bootstrap
  preinstall with scope `all`: local devices work again, on in every organization, and an org admin
  may switch them off. Local devices made before the upgrade are deleted and must be reconnected;
  upgrade `capybara-device` together with the kernel.
- Updated dependencies [d0e209d]
  - @capybara-hq/kernel@0.1.0-rc.72

## 0.1.0-rc.91

### Patch Changes

- bda4e7b: The super admin pages follow the responsive system. The admin views' choices (the owner filter of
  the template lists and the like) are scopes, and the super admin lists page through their list
  (`onLoadMore`) instead of loading everything at once.
  
  `ItemList` pages: `onLoadMore`, `hasMore`, `loadingMore` and `loadMoreError` draw the Load more row
  at its end.
  
  The `SCOPE_PENDING` and `LOAD_MORE_PENDING` allowlists of the guards are gone: `check:web-ui` now
  fails a `Segmented` / `Tabs` inside `ListPage.filters` and a Load more row drawn by a page.
  
  Sizing audit: three super admin pages (a list, a detail and a form) join the responsive visual
  matrix, with the 44 px hit-size and no-horizontal-scroll checks at 390.

## 0.1.0-rc.90

### Patch Changes

- Updated dependencies [9318195]
- Updated dependencies [d5d295f]
  - @capybara-hq/kernel@0.1.0-rc.71

## 0.1.0-rc.89

### Patch Changes

- 14978b9: The new conversation's composer in the mobile form sits at the window bottom (space.3 over the
  safe-area inset, as the conversation's), no longer over an empty ~128 px band: the thread's reserve
  for the floating composer applied to the new conversation's scroll too, whose composer is inside it.
- a938c37: The composer exposes its pieces as UI parts: `composer.box` (the text with ＋ and send; the
  floating pill in the mobile form, `:focus-within` while one of them has focus, never for the control
  row), `composer.options` (the mobile settings chip) and `composer.send` (send, and stop in its
  place). The pill is now that real element instead of the frame's `::before`, so a theme's frame,
  corners and run effects can follow it without enclosing the chip row; the control row sits outside
  it (the DOM order is the text, ＋, send, then the row). In the mobile form send keeps its place at
  the pill's end when the agent picker above it is wider. `Button` and `IconButton` let a caller's
  `data-cap-part` name the control too.
- 5f10f47: The org admin pages (settings members, tokens, schedules and audit, extensions, trajectories, evals)
  use the responsive compact rows, and join the responsive visual matrix.
  
  The conversation list counts its matches only when asked (`withTotal=true`, first page), so the
  compact drawer's 30 s poll no longer pays for the count.
  
  DataTable columns can be `compactOnly`: drawn only in the compact grouped rows, never in the wide
  table.
- Updated dependencies [5f10f47]
  - @capybara-hq/kernel@0.1.0-rc.70

## 0.1.0-rc.88

### Minor Changes

- 5bef1fd: Local device semantics leave the kernel: the kernel-internal `@local` provider, its machine
  reports, owner reports, instance bindings and boot history are gone; the kernel knows only
  generic dial-in devices (a provider implementing `DeviceProvider.dialIn` and declaring
  `permissions.dialIn`), and the `device-local` plugin takes local devices over. Until it is
  installed, a deployment has no local device provider. Local devices registered before the upgrade stay
  bound to the removed `@local` provider and are unavailable (`device.unavailable`; their files stay
  on the machine); their owners delete them on the devices page and connect the machine again with a
  `capybara-device` that signs in to the `device-local` provider. Migration 0177 drops `device_machines`'
  `features`, `local_policy`, `owner_report`, `pending_policy_ops`, `home`, `roots`, `mode` and
  `session_isolation`, the tables `device_machine_boots` and `device_instance_bindings`, and
  `devices.source`; a machine credential is accepted for any device a machine signed in to, and the
  connection's provider check decides the rest. The error codes `device.policy_refused`,
  `device.policy_unsupported` and `device.owner_report_stale` are removed. The dial-in config moves from
  `devices.local.*` to `devices.dialIn.*` (`CAPYBARA_DEVICES__LOCAL__*` becomes
  `CAPYBARA_DEVICES__DIAL_IN__*`); rename any value you set.
  
  The SDK's `device-protocol` subpath drops the protocol 4 surface: `LEGACY_DEVICE_PROTOCOL_VERSION`,
  `LegacyDeviceHello`, `LegacyDeviceFrame`, `parseLegacyDeviceFrame`, `KernelReq`, `KernelCancel`,
  `DeviceRes`, the policy op types and constants (`LegacyDevicePolicyArgs`,
  `LegacyDevicePolicyResult`, `LegacyDevicePolicyStatus`, `DevicePolicyStatusArgs`,
  `DevicePolicyOpReport`, `DevicePolicyOpOutcome`, `isPolicyOpId`, `POLICY_ADD_REFUSED`,
  `MAX_POLICY_OP_ID_LENGTH`, `MAX_RECENT_POLICY_OPS`) and the `policyOp` / `policyOpId` features;
  `DeviceOp` no longer lists `policy` / `policyStatus`.

### Patch Changes

- b8588c5: Responsive system, phase 1: the member pages (schedules, the account tables, skill detail) draw
  compact grouped rows below 600, and every action a row offers is reachable on its detail page.
  Conversation rows carry their agent and the list an exact total (kernel API and web). Dialogs keep
  their state across the 600 boundary, and every compact CSS block uses the ClassForms query.
- Updated dependencies [f761d8f]
- Updated dependencies [c69c0f0]
- Updated dependencies [6265634]
- Updated dependencies [76b2320]
- Updated dependencies [b449aa8]
- Updated dependencies [5bef1fd]
- Updated dependencies [b8588c5]
  - @capybara-hq/kernel@0.1.0-rc.69

## 0.1.0-rc.87

### Patch Changes

- c6935ea: Mobile interaction model (#606): on compact, dialogs and danger confirmations are bottom sheets
  (close or 取消 focused first, a fixed footer, typed names kept) and a Select opens a picker sheet
  (searchable over ten options); toasts sit at the bottom, one at a time, and a queued toast's timer
  starts when it is shown; a focused field scrolls above the keyboard and bottom sheets rise with it;
  compact lists load the next page as their end comes into view (`onLoadMore`, `hasMore`,
  `loadingMore`), with a retry row on error; a long press that opens an action sheet plays a light
  haptic; pull to refresh on the inbox, the conversations page and the drawer's recents in the mobile
  app only. On the iPhone Duo the strip pill carries the page's primary (else 新会话), 对话 opens the
  conversations page, the avatar opens the account sheet (with 技能、连接器、设备…), sheets stay
  inside the strip's inset and the drawer drops the pill's entries. New checks keep overlays and sheet
  rows design primitives, `useNative` out of pages, Dialog footers flat and Load more rows out of
  pages.

## 0.1.0-rc.86

### Patch Changes

- 6d54a3a: The templates take their compact forms (responsive system phase 0, second part). Below 600 every
  `ObjectList` is one grouped list of rows: a row that opens something shows no buttons, ends in a
  chevron and opens its actions in an action sheet on a long press or right click, and a row that
  opens nothing keeps its one button and a labelled ⋯. The page head is the compact head (no path
  row, a large title with its count, the primary as a block or head button, the secondaries in the
  shell's "…", full-width search and a segmented first-level tab row). Every pushed template is one
  scroller with a title that scrolls away and a quick-return search bar, and the compact ListPage
  draws a scope chip row, a floating primary and restores its scroll position. The workspace
  agents page uses the typed list scope instead of a segmented control in its filters.

## 0.1.0-rc.85

### Patch Changes

- 1834986: An `oauth_code` auth preset may set `authorizationParams`, extra query parameters of the
  authorize request (Google's `access_type: "offline"` and `prompt: "consent"`, Slack's `team`):
  at most 10, lowercase names, plain printable values, never a secret. The kernel appends them after
  its own parameters on every connect and reconnect, never on a token request. Names the kernel owns
  or that would change the callback or the token exchange (`OAUTH_RESERVED_AUTHORIZATION_PARAMS`)
  are refused there and in the query of a manual `authorizationUrl`. A template update that changes
  only `authorizationParams` keeps members' connections. A member whose access token dies without a
  refresh token is now asked to reconnect instead of told the authorization server is unavailable.
  `startFakeOAuthServer` records the form parameter names of each token request (`paramNames`).
- 794cc3c: The image pins device-docker rc.22 as its cloud device provider.
- 6a0c32f: Responsive system, system pieces (#605): `ClassForms` / `useClassForm` render a structure per size
  class (both on the server, CSS shows one, only the matching one stays mounted after hydration);
  the `ActionSheet` uses the native `menu@1` sheet on compact when it holds no links; card grids are
  one grouped list of rows below 600 (no buttons, long press or right click opens the card's actions);
  DataTable columns may declare `compact` roles (title, subtitle, meta, trailing, hidden) and are
  then drawn as grouped rows below 600; `Tabs look="segmented-compact"`; `ShellPage.actions` and
  `titleAway` with the centred scrolled title, and `useCompactScroll` for one-scroller pages. New
  checks keep size-class reads out of pages, view choices out of `ListPage.filters`, template-only
  props in templates and dual renders in `ClassForms`.
- Updated dependencies [1834986]
  - @capybara-hq/kernel@0.1.0-rc.68

## 0.1.0-rc.84

### Patch Changes

- db8935e: The compact drawer follows the approved mockup: a search field and a 新会话 button at the top, the
  navigation as one grouped card (收件箱 with its count, 智能体, 定时任务, 更多), 最近会话 with 全部
  over the newest conversations by time (not grouped by agent, each with its agent, state and time;
  a long press or right click opens rename / archive / delete), and the account as one row at the
  foot. The conversations page lists conversations by time in day sections (今天 / 昨天 / 本周 /
  更早) with a search and a chip per agent, reads the next page as the end nears (no Load more rows)
  and offers each row's actions in an action sheet; on compact the page's primary is a floating
  action button (the head's primary restyled by CSS). New design pieces: `ConversationList`,
  `ActionSheet` with `useLongPress`, `ScopeChips`, `ListPage.scope`, `formatListTime` / `dayBucket`.
- 42e4ae0: `device-provider@1` providers now declare `networkAllowlist: true` and implement
  `report(device, signal)`, which answers a `DeviceReport` (revision, description, home, limits,
  reset; checked by `parseDeviceReport`). A provider can refuse a project directory with
  `ProjectPathRefusedError`. The kernel refuses to load a provider that lacks any required member.
  The kernel stores each device's report (`devices.report`, migration 0175), refreshed after its
  instance is created or resumed; request paths read the stored copy.
- 316af53: The web's brand cookie is named `__Host-cb-brand` over https (plain `cb-brand` only over http), so a
  sibling subdomain cannot plant the wordmark of error pages; the web keeps a trusted proxy's
  `X-Forwarded-Proto` (`CAPYBARA_WEB_TRUST_PROXY`).
- a0e48a2: Pages outside the theme (#451): the kernel-starting frame, the root error pages and the root 404
  draw the theme this browser last drew (the `cb-brand` cookie, else the platform default); app
  icons and the manifest colours follow the platform default theme; the browser's theme colour
  follows the scheme shown (design `useThemeColorMeta`).
- 599ed63: One bottom sheet look (spec §6.59, maintainer decision 2026-11-22): a 52 high head with no
  hairline, the title centred and a 30 px round close on a fixed ground at the body's 14 px inset,
  its 44 px hit area an invisible ring, so nothing paints on open; shared body parts (`SheetGroup`,
  `SheetRow`, `SheetFootnote`). The account sheet is regrouped: a profile row that opens Personal
  settings, 组织 with the current org (a menu with several), 语言 and 外观, sign out alone, the
  status line as a footnote. `AccountSheetData` takes `orgMenu`, `language: { value, label, items }`
  and the theme switch's data instead of slots.
- 2c28141: An org's default theme can now shape the agent avatar choices: it may hide built-in presets and add presets of its own. The kernel lists them in `GET /orgs/:orgId/themes` (`avatars`), accepts a theme preset key on create and update (stored pinned to the theme version, `agent.avatar_unavailable` when the org does not offer it), and draws the random default from the visible choices. `AvatarPicker` gains `hidden` and `extra`, and the web create form, template flow and basics section follow the org's choices.
- 7a8e816: Theme brand graphics (#451): the empty state, the greeting and the working line draw the theme's
  mark or illustration (the empty-state art as a mask in the faint colour), a theme can turn the
  sign-in decoration off, and a theme mark that fails to load falls back to the pixel capybara.
- Updated dependencies [718eb52]
- Updated dependencies [c49d70e]
- Updated dependencies [f4c2ae8]
- Updated dependencies [42e4ae0]
- Updated dependencies [78fe943]
- Updated dependencies [2c28141]
  - @capybara-hq/kernel@0.1.0-rc.67

## 0.1.0-rc.83

### Minor Changes

- 19d5e1a: The product name people see follows `platform.name` (unset: Capybara) everywhere, not only in the
  document title and the web app manifest (issue #452).
  
  - Kernel: the IM bot's bind and web-hint phrases, the OAuth dynamic client registration name, the
    session user agent of desktop and mobile sign-ins, the `<name>:` prefix on git gateway messages,
    the platform overview the model reads, and the attribution defaults
    (`Co-Authored-By: <name> <noreply@capybarahq.com>`; the pull-request line links the upstream
    project only under the default name). The official marketplace is now named "Official
    marketplace", and messages that named the software in passing say "the platform".
  - Web: every message that named the product takes the platform name from the public meta,
    including the sign-in, binding, invitation and app consent pages. Pages that cannot
    read the kernel (the root error page, a starting kernel) say the built-in name. `check:i18n`
    rejects the literal "Capybara" in web messages (`i18n-product-name`).
  - Design: `Brand` gains `productName`, the `alt` of a theme's logo mark (else the wordmark, else
    "Logo"). The built-in `CAPYBARA` wordmark stays beside the pixel capybara whatever the name.

### Patch Changes

- fabb3e7: Markdown is parsed with the CommonMark CJK-friendly emphasis amendment
  (`micromark-extension-cjk-friendly`): `按**「框架」**来`, `**（注意）**这里` and `~~「旧」~~` render as
  strong and strikethrough instead of literal asterisks, in conversations, file previews, skill docs and
  other rendered Markdown.
- 4bb6105: Compact: the floating back button no longer pauses about half a second before its transition. The
  back settles as soon as the shell commits the route it landed on (or on the task after its
  `popstate` when no route changed) instead of waiting for a frame the browser does not render while
  a view transition's update is pending.
- 071db76: Compact: the floating back button no longer slides the page in twice. A pop the back button
  animates with a view transition sets no CSS slide on the shell's main region, so the slide does not
  run again once the transition ends.
- 582c029: Controls take the mobile sizes at the compact size class whatever the pointer, and on a touch
  device at any width (`MOBILE_SIZE_QUERY`, exported beside `TOUCH_QUERY`): a narrowed desktop window
  gets 44 px buttons, tabs and text fields with 16 px field text, as a phone does, instead of the
  28 px desktop controls. A control with text pads wider than it is tall (buttons and chips 16 at the
  sides, tabs 16, segments 16 filling a 44 high group with the selected ground drawn inset, field
  text 12 from the border); icon buttons stay square. The touch component forms (large list rows,
  the bottom sheet's touch form, drawer rows, floating buttons) follow the width too. The settings sub-nav on a phone fades at the edge it scrolls past and keeps the current item
  in view. The system font stays touch only.
- a6348e1: The compact drawer and the bottom sheets no longer scroll sideways: the drawer's conversation
  section and the account sheet's rows kept the sidebar's and an older negative margin (8 px too wide
  each), and the drawer is now a vertical-only scroller with the thin scrollbar. The account sheet's
  rows share one text column, its labels never wrap and the status line wraps inside its column. A
  bottom sheet's close button sits on the rows' edge; the options sheet's notice is styled for every
  pointer on the rows' text column. The focus an overlay moves on open draws no ring unless it was
  opened from the keyboard.
- f74b0f9: Compact (below 600) inside the desktop shell with window controls: the floating row is a flat
  title bar like the rail's band (one row as high as the controls, a hairline under it, ghost
  desktop-size menu and "…" buttons); the conversation title is plain text that drags the window and
  the title menu's items move into "…". Everywhere on compact: the floating "…" is the same size as
  the menu button and the title pill, and the page head draws no path row.
- 581c6c7: Inside the desktop shell the page path in the top row follows what precedes it (the content column's
  start padding beside the full sidebar, right after the band's sidebar toggle past a rail) instead of
  the centred content frame, and a path of the org slug alone is not shown there. The medium rail gets
  a sidebar toggle (in the desktop band after the window controls, in the browser where the expand
  button sits) that opens the full sidebar as a drawer over the content; ⌘\\ / Ctrl+\\ opens and
  closes it on medium.
- 9c46c28: Stopping a conversation's run (and an offboarding run stop) no longer misses a run that suspends
  for an approval or input at the same moment: after the stop marker is set, a run found `waiting`
  is ended directly, so it never stays waiting with the stop lost.
- bfb0fc0: An identity source can refuse an account on purpose: the SDK adds `IdentitySourceRefused` and
  `isIdentitySourceRefused`, and a login refused that way returns to the sign-in page with
  `sso.account_not_allowed` ("This account is not allowed to sign in on this platform…") instead of a
  generic provider error. The plugin's message is only logged.
- f32b8a2: Themes: the public asset route serves a theme's illustration, app icons and avatar files (only the
  files the stored definition names), the catalog import stores them, and `ThemeRef` (theme listing,
  platform default) carries `logo.illustrationUrl`, `logo.appIconUrl`, `logo.appIconMaskableUrl`,
  `decoration` and `background` (the merged `bg` of each scheme the theme defines) (#451).
- Updated dependencies [9c46c28]
- Updated dependencies [8ef62d6]
- Updated dependencies [19d5e1a]
- Updated dependencies [4f3c400]
- Updated dependencies [bfb0fc0]
- Updated dependencies [f32b8a2]
  - @capybara-hq/kernel@0.1.0-rc.66

## 0.1.0-rc.82

### Patch Changes

- 8f70749: Every unsupported permission availability carries its cause (a runtime report and a missing preview had none, which crashed the new conversation's mode menu into a 503 page); the desktop band's hairline is drawn only while the rail is shown.
- Updated dependencies [8f70749]
- Updated dependencies [10923f5]
  - @capybara-hq/kernel@0.1.0-rc.65

## 0.1.0-rc.81

### Patch Changes

- 5481127: An image generation call measures its latency once: the `model.response` hook payload and the
  returned result report the same `latencyMs` (they could differ by a millisecond).
- Updated dependencies [5481127]
- Updated dependencies [4697ec6]
  - @capybara-hq/kernel@0.1.0-rc.64

## 0.1.0-rc.80

### Minor Changes

- 59e2551: Merge the extra bootstrap manifest into the built-in one at start and in `capybara bootstrap` (`--extra-manifest`, else `bootstrap.extraManifest`), and sync its marketplaces.
- 8416855: Apply the extra bootstrap manifest's `defaultTheme` as the platform default theme at every start while the `uiTheme` setting is still the seed (a super admin's choice is never reset); the dual-replica harness takes `bootstrap.extraManifest`.

### Patch Changes

- Updated dependencies [56af2e0]
- Updated dependencies [b491e2a]
- Updated dependencies [24fa482]
- Updated dependencies [59e2551]
- Updated dependencies [8416855]
- Updated dependencies [13369a0]
  - @capybara-hq/kernel@0.1.0-rc.63

## 0.1.0-rc.79

### Patch Changes

- c93db41: Bootstrap and the compose sandbox profile move to sandbox-docker 0.1.0-rc.21, whose image stages the
  current SDK runtime: with rc.20 a current kernel refused every cloud device with "The staged
  native-files.py does not match its digest".

## 0.1.0-rc.78

No changes in this release.

## 0.1.0-rc.77

### Patch Changes

- Updated dependencies [8453226]
  - @capybara-hq/kernel@0.1.0-rc.62

## 0.1.0-rc.76

### Minor Changes

- 946c9eb: `capybara secrets rewrap` also rewraps sealed push tokens and prints their count.

### Patch Changes

- Updated dependencies [33074e1]
- Updated dependencies [12a6582]
  - @capybara-hq/kernel@0.1.0-rc.61

## 0.1.0-rc.75

No changes in this release.

## 0.1.0-rc.74

No changes in this release.

## 0.1.0-rc.73

### Patch Changes

- 0b07aa6: The approval card holds a crossing's details while it is pending: the agent's reason leads the
  card, the working directory is one line above the command, a permission crossing's reach is a
  compact list above it, and the long explanation is a short hint under Allow once. Decided or
  superseded, only the card's one line remains.

## 0.1.0-rc.72

### Patch Changes

- 072362d: Desktop onboarding: `GET /api/v1/meta` lists `appRedirectUris` (`auth.appRedirectUris` while app
  sign-in is available, else empty), so the desktop app can say before opening the browser that the
  platform does not allow it; the app token exchange answers `auth.account_disabled` (403) for an
  account that is not active instead of `app_auth.code_invalid`. `chrome@1.setAppearance` also
  carries the page's seven main color tokens (only when all are plain colors) and `singleScheme`
  under a single-scheme UI theme; the SDK gains `ChromeCapabilityV1`, `ShellChromeTokens` and
  `SHELL_CAPABILITY_KEYS.chrome`.
- 8f684ad: A local device's hello names its program run (`programRunId`, random per process). When the machine
  reconnects as a new run before answering a request, the kernel ends that request's wait at once with
  a tool error saying capybara-device restarted and the result is lost, instead of waiting out the
  command's whole timeout plus the reconnect grace.
- 4ae3971: The Platform tool takes conversation files where the web takes an upload: an agent avatar from a
  generated image, skill and plugin packages, extension packages and skill versions, passed as
  `file: { fileId }` (a device file is delivered with Deliver first). The card shows the file's name,
  size, sha256 prefix and a thumbnail, and the bytes that run are the bytes the person confirmed.
  Imports, uploads and anything else a person reviews on a web page pop up a link card to that page.
  Two new platform-ops rules keep it that way: an exclusion may not cite an upload, and an operation
  that sends the person to a web page links it or says why not (`noHandoff`).
- 44a41de: A skill with files loads on a local device again: its preparation grants the marker directory
  instead of the marker file, which the device pins as a directory (ENOTDIR, or a marker created as
  an empty directory).
- Updated dependencies [a767452]
- Updated dependencies [072362d]
- Updated dependencies [10c0ee8]
- Updated dependencies [4ae3971]
  - @capybara-hq/kernel@0.1.0-rc.60

## 0.1.0-rc.71

### Patch Changes

- e0925f9: A conversation bound to a project works in the project's root even before a run start recorded a
  snapshot (the device was offline or the read timed out); only a recorded unavailable snapshot moves
  it to the device's workspace.
- 2c2841e: The Platform tool creates connectors, sets their credentials, installs catalog items with their
  connector and config secrets, and creates channels, with every secret typed by the person on the
  confirmation card. Org admins' agents invite, revoke and manage members (never self, never an owner,
  never above the actor); an invitation link is sealed for the approver and revealed once on the web.
  Platform results can pop up a handoff card (a link to a web page, or a Connect button for OAuth).
- Updated dependencies [2c2841e]
- Updated dependencies [ff64a43]
  - @capybara-hq/kernel@0.1.0-rc.59

## 0.1.0-rc.70

### Patch Changes

- e788a1a: Person fields: a Platform write that needs a secret takes its field name in `askPerson`, and the
  person types the value on the approval card on the web; it is sealed, read once by the resumed call
  and never reaches the conversation, the audit or a log. Agents can now read and set extension
  deployment config, org config and the org's config copy through the Platform tool.
- Updated dependencies [e788a1a]
  - @capybara-hq/kernel@0.1.0-rc.58

## 0.1.0-rc.69

### Patch Changes

- 6992d56: The permission menu no longer shows "Checked when this device starts" for a device not checked yet.
- Updated dependencies [dbbd95b]
  - @capybara-hq/kernel@0.1.0-rc.57

## 0.1.0-rc.68

No changes in this release.

## 0.1.0-rc.67

### Patch Changes

- 7548c26: Bootstrap pins sandbox-docker 0.1.0-rc.20 (the R3 instance boundary: support v2, no `limits.mode`,
  the egress proxy's closed address classes and fake-IP DNS-over-HTTPS, host addresses denied) and moves
  the marketplace and the compose sandbox image builds to plugins ae438ab. sandbox-docker rc.20 needs
  kernel 0.1.0-rc.55 or later.

## 0.1.0-rc.66

### Patch Changes

- Updated dependencies [e39c372]
  - @capybara-hq/kernel@0.1.0-rc.56

## 0.1.0-rc.65

### Patch Changes

- 1efb3e1: Device sandbox settings (approval-only profiles, R3 T2). The platform's `devices.fullAccess` becomes
  `devices.outsideSandbox` (`CAPYBARA_DEVICES__OUTSIDE_SANDBOX`, admin `devicesOutsideSandbox`), and new
  hot keys `devices.network.default` / `devices.network.ceiling` (`open` or `allowlist`, admin
  `devicesNetwork`) set the device sandbox network; both are covered by the permission configuration
  fingerprint (projection version 3). The org settings `fullAccess` and `cloudNetwork` become
  `outsideSandbox` and `deviceNetwork { default, ceiling, base, extraHosts, excludedHosts }`; a default or
  ceiling above the platform's ceiling is refused with `org.network_not_allowed`, and the refusal codes
  are renamed `org.outside_sandbox_not_allowed` / `deployment.outside_sandbox_not_allowed` (new:
  `deployment.network_not_allowed`, `device.network_not_allowed`, `device.outside_sandbox_not_allowed`).
  The old config keys and environment variables are refused with a conversion message, and
  `capybara config migrate-permissions` converts a config file (an old `off` also sets
  `devices.network.ceiling: allowlist`, so nothing widens). Stored old keys are read narrower and kept in
  step until the permission configuration publication converts them. Migration `0165` adds a cloud
  device's `network_mode` and `network_hosts`, copied from an allowlist outer network snapshot.
  
  The stored-key conversion runs at every permission configuration publication and stores exactly what
  readers saw. An old `off` (platform, org, file, Nacos, environment or an invalid value) converts to
  `outsideSandbox: off` plus the allowlist network ceiling: cloud devices of such a platform or org that
  ran on the open network now get the allowlist (the conversion logs a warning naming each, with how to
  reopen it). At the version conversion, cloud devices whose old effective network was the allowlist
  (for example sandbox-mode devices under `sandbox.limits.orgHosts: within`) keep it
  (`network_mode: allowlist`).
  
  Release note: once a new replica has converted the permission configuration publication to version 3,
  rolling back to an older image is blocked (its replicas fail the publication barrier), as with B1.
- Updated dependencies [bf8c74b]
- Updated dependencies [e31f31b]
- Updated dependencies [ebeedd7]
- Updated dependencies [47e2558]
- Updated dependencies [23bee16]
- Updated dependencies [5567108]
- Updated dependencies [0c0f51f]
- Updated dependencies [d6be3f7]
- Updated dependencies [89ae9e7]
- Updated dependencies [1efb3e1]
- Updated dependencies [da0323f]
- Updated dependencies [3e02f3d]
- Updated dependencies [3ec77c8]
- Updated dependencies [859d6fc]
- Updated dependencies [d855f2f]
- Updated dependencies [f5b114c]
- Updated dependencies [b9ab9eb]
- Updated dependencies [4253de0]
- Updated dependencies [df0b43c]
- Updated dependencies [89ef174]
- Updated dependencies [00742c4]
- Updated dependencies [7f7db5f]
- Updated dependencies [7f7db5f]
- Updated dependencies [1eceaf8]
- Updated dependencies [42f9a12]
  - @capybara-hq/kernel@0.1.0-rc.55

## 0.1.0-rc.64

No changes in this release.

## 0.1.0-rc.63

### Patch Changes

- 872d26b: Native apps sign in through the browser: `POST /api/v1/app-auth/authorize` (a signed-in person's
  consent) issues a one-time code bound to a PKCE S256 challenge and a redirect URI from the new
  `auth.appRedirectUris` (default `["capybara://auth/callback"]`), and `POST /api/v1/app-auth/token`
  exchanges it once, within 60 s, for an ordinary web session of the app's own.
- 0d10b80: `GET /api/v1/meta` returns the platform icon URL when one is uploaded, and reports
  `features.appSignIn` only when `http.publicUrl` is set.
- ddc2f3c: Add the `platform.name` config field and the public `GET /api/v1/meta` discovery route (platform
  name, icon, device protocol range, features) for native clients and the installed web app.
- 1835433: The web is an installable PWA: `/manifest.webmanifest` carries the deployment's name
  (`platform.name`, "Capybara" unset) and platform icon (the app and maskable icons, else the
  Capybara set the web ships), and the page title, the iOS web app title, the favicon and the
  apple-touch-icon follow them. A signed-out browser may read the manifest and the two default PNG
  icons (the sign-in proxy skips exactly those names). The super admin's deployment settings gain
  应用图标 / App icon: upload the app icon, its maskable variant and the SVG favicon, or restore the
  default; the `/api` proxy admits 2 MiB for the icon upload.
  
  The design system exports `PAGE_BACKGROUND` (the page background per theme) for what cannot read a
  CSS variable.
- Updated dependencies [872d26b]
- Updated dependencies [0d10b80]
- Updated dependencies [6b3e60e]
- Updated dependencies [ddc2f3c]
  - @capybara-hq/kernel@0.1.0-rc.54

## 0.1.0-rc.62

### Patch Changes

- Updated dependencies [5bfad28]
  - @capybara-hq/kernel@0.1.0-rc.53

## 0.1.0-rc.61

### Patch Changes

- d91ad92: Agent map: every node (root and sub-agents) is the same bordered compact card, siblings `space.2`
  apart; the status legend moves into a tooltip on the count line; line 2 shows the model's display
  name alone, so it no longer collapses into an ellipsis behind the provider prefix.
- 8b3450b: The purpose list no longer warns that extensions cannot call models yet under an extension's
  purpose: extensions call `ctx.models.embed` / `generateImage` with their declared purposes.

## 0.1.0-rc.60

### Patch Changes

- a01098a: Images: `Read` shows images, the new `vision` model purpose reads them for models without vision,
  and `GenerateImage` returns standard-size images by default.
- Updated dependencies [a01098a]
  - @capybara-hq/kernel@0.1.0-rc.52

## 0.1.0-rc.59

### Patch Changes

- d3d88bb: The agent map is compact: every agent is a 44 px row (was a 62 px bordered card) 336 wide, siblings
  4 px apart (was 8), no box per row (hover and the open agent get a ground), the root a quiet card
  level with its first child instead of centred on a long column, and the connectors meet each row's
  centre. On a row's meta line only the model name gives way; time and tokens always stay whole.
  The count line, legend and background task rows are tighter, and the agent's summary dialog has two
  meta lines (spawner, time and tokens on one) and tighter body and footer padding.
- 7e44853: Bootstrap pins skills-core 0.1.0-rc.2 (skill-guide states the package requirements instead of a `zip -r`
  recipe); the official marketplace commit and the compose sandbox build contexts move with it.
- Updated dependencies [7e44853]
  - @capybara-hq/kernel@0.1.0-rc.51

## 0.1.0-rc.58

### Patch Changes

- Updated dependencies [1c6ca44]
- Updated dependencies [c30ec7c]
- Updated dependencies [cbf2c8f]
- Updated dependencies [2fcd0c0]
- Updated dependencies [3cb0cf5]
- Updated dependencies [7f86c80]
- Updated dependencies [32851e9]
- Updated dependencies [a45db84]
  - @capybara-hq/kernel@0.1.0-rc.50

## 0.1.0-rc.57

### Patch Changes

- eea8ef6: Model-facing text states mechanisms, contracts and limits only. Bash keeps the proxy rule general
  (no browser flag) and says "keep results in files" once; Deliver states the one-file contract and
  that an HTML file is shown on its own (no tar or CDN recipe); the skill registration errors state
  the zip package format instead of a `zip -r` recipe; Read / Glob / Grep drop the write-approval
  sentence; the ToolSearch catalog header, WebSearch (cite once, in the description), the WebFetch
  extraction prompt, Agent / SendMessage results and the Platform tool and operations lose
  duplicated or one-slip warnings ("never guess", "there is no all", "agents never decide" in every
  hint, "never remembered", old field-name hints). Platform text names pages by their English
  labels. Agent docs: `concepts.md` describes devices instead of "a sandbox per conversation", and
  the docker socket rule leaves the model-facing sandbox doc (it stays in the contributor skills).
  The new-agent AGENTS.md starter no longer repeats the platform's behaviour rules.
- 4e9bc7e: The web shows prompt suggestions in the conversation composer (Tab fills, Esc or typing dismisses
  for that run), with a 输入建议 / Prompt suggestions switch on the admin and organization settings
  pages, and labels the `cap-kernel-suggestions` queue on the admin overview.
- df19d51: The timeline shows one image placeholder per requested image up to the configured maximum of 10
  (it stopped at 4).
- Updated dependencies [b8e2313]
- Updated dependencies [2577900]
- Updated dependencies [5de7182]
- Updated dependencies [95fed18]
- Updated dependencies [bb2b304]
  - @capybara-hq/kernel@0.1.0-rc.49

## 0.1.0-rc.56

### Patch Changes

- dba64f6: Bash, its run_in_background field, TaskOutput and the background launch result now tell the model
  when the background is the right place (servers, watchers, long jobs it does not need yet) and to run
  a command whose result it needs in the foreground instead; TaskOutput is for reading logs (block
  false for servers and watchers) and collecting output after the notification.

## 0.1.0-rc.55

### Patch Changes

- ff84575: A background Bash launch no longer shows as failed in the conversation: it has no exit code yet,
  and its task's end is reported on its own.
- d3fe7c3: TaskOutput and TaskList calls get their own tool kind: a group waiting on a background task says
  "Waiting on a background task" instead of "Reading file", and done ones count as background task
  checks, not file reads.
- adb0b31: While GenerateImage runs, the conversation shows one placeholder per requested image, shaped by
  the requested aspect ratio, and the images replace them in place.
- Updated dependencies [bc6def9]
  - @capybara-hq/kernel@0.1.0-rc.48

## 0.1.0-rc.54

No changes in this release.

## 0.1.0-rc.53

### Patch Changes

- 228db64: The file-preview bootstrap pin moves to rc.3 (capybara-hq/plugins#129): the plugin drops its `html` previewer, since the kernel's built-in previewer renders HTML. The marketplace pin and the sandbox-docker build contexts move to capybara-hq/plugins 84a5307; every other pin already matches that commit's marketplace.
- Updated dependencies [228db64]
  - @capybara-hq/kernel@0.1.0-rc.47

## 0.1.0-rc.52

### Patch Changes

- Updated dependencies [909442f]
- Updated dependencies [909442f]
- Updated dependencies [909442f]
- Updated dependencies [909442f]
- Updated dependencies [909442f]
- Updated dependencies [909442f]
  - @capybara-hq/kernel@0.1.0-rc.46

## 0.1.0-rc.51

### Patch Changes

- 106f7c5: The file-preview bootstrap pin moves to rc.2 (capybara-hq/plugins#127): scrollbars draw as the theme's thumb on a clear track. The marketplace pin and the sandbox-docker build contexts move to capybara-hq/plugins d83e667, which also lists releases core had not pinned yet, so those pins move with it: openai rc.11, bailian rc.10 and ark rc.10 (image generation, capybara-hq/plugins#125) and sandbox-docker rc.19 (on core R1, capybara-hq/plugins#123).
- Updated dependencies [106f7c5]
  - @capybara-hq/kernel@0.1.0-rc.45

## 0.1.0-rc.50

### Patch Changes

- 5f6f6b1: An extension shipped in a builtin platform plugin (a `builtin: true`, not required bootstrap entry
  such as file-preview) is now enabled in every org, existing and future, like a required one: the
  org enablement helpers count live builtin platform catalog items, so its tools, previewers and
  other org-scoped capabilities work everywhere. Before, its plugin showed on with a locked switch
  while the extension stayed off in every org with no way to turn it on.
- Updated dependencies [5f6f6b1]
  - @capybara-hq/kernel@0.1.0-rc.44

## 0.1.0-rc.49

### Patch Changes

- 2c333b9: The agent form lists GenerateImage while the org's image purpose has a target, and the model purposes pages offer image models for the image purpose and hint when none is mapped.
  
  A new member-readable route, GET /api/v1/orgs/:orgId/model-purposes/available, says whether each purpose has a usable model in the org (the image purpose also needs an object store, exactly as GenerateImage does), so the agent form gates GenerateImage for every member.
- Updated dependencies [ee9a4b5]
- Updated dependencies [ade6e20]
- Updated dependencies [2c333b9]
  - @capybara-hq/kernel@0.1.0-rc.43

## 0.1.0-rc.48

### Patch Changes

- c5d2996: The file-preview bootstrap pin moves to rc.1 (capybara-hq/plugins#121): its THIRD-PARTY-LICENSES.txt covers the whole production dependency closure of the prebuilt bundles. The marketplace pin and the sandbox-docker build contexts move to capybara-hq/plugins c9f2fc7, which only adds that release.
- c04a4d1: `capybara config migrate-permissions --in <file> --out <file>` converts a config file (or a saved
  Nacos data id) to the new permission keys (`devices.autoMode` -> `devices.fullAccess`) in place,
  keeping every other key and comment, refuses conflicting or invalid values, never overwrites the
  output and names the environment variables to rename.
- c9fde6f: Add explicit startup CAS activation of resolved permission configuration with bounded PostgreSQL
  cancellation, idempotent retries and atomic semantic revocation. Ordinary stale restarts cannot replace
  active deployment authority. Expose the start-only `--activate-permission-config` operator option.
- 012f74e: `capybara permissions cutover report | freeze | snapshot` drive the permission runtime cutover. The
  report shows the pre-checks (local devices without a boot identity, cloud devices with unknown
  incarnations), live replicas on another version, legacy rows only an old unfenced replica writes, the
  freeze, the retirement obligations and the cloud snapshot's progress. The freeze returns only once
  its enumeration settled and records it (migration 0158); the snapshot runs the new cloud snapshot
  driver behind that barrier, under each device's lifecycle lease, idempotently and resumably. The
  report and the freeze need PostgreSQL only; `--json` prints machine-readable output.
- Add owner-scoped conversation permission reads and selected-device permission previews to the web
  query cache, preserving account isolation and direct permission API response shapes. Profile controls
  and execution changes remain gated by the coordinated runtime cutover.
- Updated dependencies [8a84219]
- Updated dependencies [c5d2996]
- Updated dependencies [ce94b4d]
- Updated dependencies [ab911e3]
- Updated dependencies [dbac47e]
- Updated dependencies [47926ef]
- Updated dependencies [2ea4298]
- Updated dependencies [2256b24]
- Updated dependencies [124eb1f]
- Updated dependencies [a4974d5]
- Updated dependencies [09de26a]
- Updated dependencies [6429c80]
- Updated dependencies [3069b5d]
- Updated dependencies [c9fde6f]
- Updated dependencies [429e837]
- Updated dependencies [2655a98]
- Updated dependencies [cdf5abd]
- Updated dependencies [e366658]
- Updated dependencies [c94c7c4]
- Updated dependencies [22617f8]
- Updated dependencies [87886a2]
- Updated dependencies [243109f]
- Updated dependencies [587dbd0]
- Updated dependencies
- Updated dependencies [28ff1e5]
- Updated dependencies [b3b3173]
- Updated dependencies [8f5af77]
- Updated dependencies [37da07e]
- Updated dependencies [46c6a52]
- Updated dependencies [6454e51]
- Updated dependencies [e826cf6]
- Updated dependencies [012f74e]
- Updated dependencies [af94040]
- Updated dependencies [dd6d426]
- Updated dependencies [0f34c66]
- Updated dependencies [0cdecf3]
- Updated dependencies [d41a57f]
- Updated dependencies [fe24223]
- Updated dependencies [61ca73e]
- Updated dependencies [bcb5d96]
  - @capybara-hq/kernel@0.1.0-rc.42

## 0.1.0-rc.47

### Patch Changes

- 2e95df3: New deployments get the official file previewer: `@capybara-hq/plugin-file-preview` rc.0 is a builtin bootstrap plugin (code, zip, xlsx, docx, pdf, svg and html previews in the conversation's right panel). The marketplace pin and the sandbox-docker build contexts move to capybara-hq/plugins 7b9ad17, which only adds that plugin.
- Updated dependencies [2e95df3]
  - @capybara-hq/kernel@0.1.0-rc.41

## 0.1.0-rc.46

### Patch Changes

- a9b728b: Bootstrap plugins move to the official marketplace at 662be35: connector-mcp rc.11, connector-openapi rc.12 and deepseek rc.10 request org-set hosts through `ctx.net.fetch`; the other preinstalls and the sandbox-docker build contexts follow the same commit.
- Updated dependencies [a9b728b]
  - @capybara-hq/kernel@0.1.0-rc.40

## 0.1.0-rc.45

### Patch Changes

- c14f7ff: Files a person sends with a message join the conversation's files: `GET …/conversations/:id/files`
  lists them with the delivered files, newest first, marked `origin: "uploaded"` (each delivered file
  is `origin: "delivered"`), and the content, previewer, preview and embed-token routes accept their
  ids. Only ready chat uploads bound to that conversation in that org count, read under the
  conversation's access as before. An attachment whose stored object no longer matches the size and
  etag finalize recorded is `removed` and refused by the content, previewer, preview and embed-token
  routes. Sending a message with files publishes `changed: files`. On the web, a sent file opens in
  the right panel once listed (it downloads until then; images still zoom in the thread), its chip
  has a download button, and uploaded files are marked 上传 / Uploaded in the file switchers.
- 517d638: Embeds may start Web Workers (`worker-src blob:`).
- d5d0e76: Image preview is a full-screen viewer instead of a dialog: the image starts fit to the window and
  zooms 10% to 800% by wheel, pinch and toolbar, pans by dragging, and a double click toggles fit and
  100%. The top bar offers open in new tab, download and close; the images of one message switch with
  the arrow keys. A sent image and the right panel's image preview both open it.
- Updated dependencies [c14f7ff]
  - @capybara-hq/kernel@0.1.0-rc.39

## 0.1.0-rc.44

### Patch Changes

- c7534e0: The core connector fixtures (`fake-connector`, `fake-openapi`) request through `ctx.net.fetch`
  with the call's `orgId` and no longer take an `allowInsecureLoopback` deployment config: test
  kernels set the kernel's `net.allowInsecureLoopback` instead (`testKernelConfig` and the replica
  runner do). The `net.*` config descriptions state that the switch lifts every loopback refusal and
  that an org's allowed internal https hosts must be listed in `net.noProxy` when `net.httpsProxy` is
  set.
  Their endpoint schemas accept http and https; `ctx.net` decides reachability at request time.
- 9f3303d: Upgrade Next.js to 16.4.6 (security)
- 9d7f620: The runs of one org append in parallel: the run loop's own writes (event appends, model output and
  usage, checkpoints, the suspend) are admitted under a shared transaction-scoped advisory lock per
  org instead of the org row lock. Every other fenced write, and every write inside a tool step,
  still takes the org row first, so tool steps stay serialized per org. Org deletion and offboarding
  take the advisory lock exclusively first, so they wait for the admitted writes and are not starved
  by them.
- Updated dependencies [c7534e0]
- Updated dependencies [23f7d29]
- Updated dependencies [b55e386]
- Updated dependencies [ac345b2]
- Updated dependencies [9d7f620]
  - @capybara-hq/kernel@0.1.0-rc.38

## 0.1.0-rc.43

No changes in this release.

## 0.1.0-rc.42

### Patch Changes

- c0a1184: Design review fixes: release-candidate tool keys in frozen sub-agent definitions are rewritten
  (migration 0144); readiness counts only the model services an organization can see and turn on; the
  notice of an unreadable template skill is shown with the sub-agent's task; a process that swallowed
  a fatal event stops gracefully and exits 1; a switch-on whose install vanished answers a retryable
  conflict; the web labels the git push policy audit action, enables a disabled model service from
  `/admin/models`, repairs an unreadable forbidden list from its notice and shares one Load more.
- 8f1950d: Drop the `legacy_format` extension status and the `catalog.legacy_format` / `extension.legacy_format`
  error codes: a package without `.capybara-plugin/plugin.json` is refused as an ordinary invalid
  package whose message names the expected manifest path.
- 4e871ad: More release-candidate compatibility removed before 0.1.0: the deprecated
  `POST /api/v1/orgs/:orgId/conversations/:id/queue` alias is gone (send with `…/messages`).
  Migration 0140 removes the history-only forms of agent definitions (an enabled `tools` list,
  `skills.orgSkills` / `skills.pinned`) from agent versions, logged sub-agent definitions and eval
  snapshots, fills both lists of every logged follow-up narrowing and drops `selectedSkills` from
  agent template versions; the kernel no longer reads those forms. Saving an agent with a policy for
  a builtin that no longer exists (`SkillWrite`) is now refused like any unknown key instead of being
  dropped silently.
  Migration 0141 deletes the plugin install ledger rows of org skills and agent templates without
  plugin provenance (shared by the org as its own items, or its own rows an old install added a
  version to; recorded before ruling P3-46); the uninstall no longer checks for promoted rows.
  Log events no longer accept the shapes of older logs: `compaction_summary` requires `savedTokens`
  and `step`, `compaction_failed` requires `step`, and `approval_requested` requires `requestedFor`
  and `approverRole` (each nullable); the web reads `savedTokens` as always present.
  Migration 0142 fills those fields on rows logged before they existed (`savedTokens` 0, `step` from
  the run's compaction usage, the approver fields from the approval row).
- e30fef0: No compatibility with release-candidate data before 0.1.0: migration 0139 rewrites the old tool
  keys left in agent versions and templates, deletes the tool grants migration 0063 could not map and
  renames the pre-rename connector audit actions (`app.created` and so on), and the kernel drops the
  readers that mapped them on every load (in-flight old tool keys, the eval replay mapping and
  `legacyKeyMatch`, the `tools.legacy_key_unmapped` startup notice, the audit action aliases). Also
  removed: the removal of retired BullMQ job schedulers at worker start, the reading of a second
  `cap_rt` cookie (the one on the old `/api/v1/auth` path is only cleared), the warning about the retired `CAPYBARA_SUBAGENTS__MAX_CONCURRENT_PER_RUN`
  variable, `aliasOf` in `GET …/conversations/:id/tools`, and the run context's fallback for messages
  that recorded no zone or language.
- c122975: `model-provider@1` is removed before 0.1.0 (no plugin provides it): the SDK drops
  `ModelProviderV1`, `ModelInfoV1`, `ModelRequestV1`, the `@1` constant
  `MODEL_PROVIDER_EXTENSION_POINT`, the deprecated `ModelInfo.capabilities.effort` and
  `ModelRequest.effort`; `EXTENSION_POINTS["model-provider"].majors` is `[2]`, so the kernel refuses
  to load a plugin providing `@1`, and its `@1` adapter is gone. `MODEL_PROVIDER_EXTENSION_POINT_V2`
  stays the constant to provide. The conformance suite in `@capybara-hq/testing` runs only `@2`
  targets: `ConformanceTarget` no longer has `contract` (drop `contract: 2`; `plugin` is required).
  The kernel's model list cache keys no longer carry the contract major.
- dbfed21: Org admins set a connector's default git push policy (allow / ask / deny) on its settings page, the
  new `PUT …/connectors/:connectorId/git-push-policy` route or the Platform operation
  `connectors.set-git-push-policy` (which may only tighten it). Members see their standing push
  decisions per repository on the connector's permissions sheet and can clear them.
- 4992759: Plugin installs drop the unused `upgrading` status: migration 0138 turns any such row into
  `installed` and tightens the status check; the kernel reads one set of live install statuses.
- 9077604: Add `capybara secrets rewrap`: after a master key rotation it rewraps every org data key and pending
  initial password sealed with a key in `masterKeyPrevious` with the current `masterKey`, in batches,
  idempotently, printing counts and never a key. The kernel's `rewrapDataKeys` becomes
  `rewrapToCurrentMasterKey` (batched, both tables, checks every key in use first) plus
  `rewrapMasterKeys` for the CLI. The deployment guide has a zero-downtime rotation runbook.
- 3ee2265: `model_call.request.toolsOmitted` records that the kernel left a step's tools out because the model
  has no tool support; the tool-change notice reads it instead of matching the reminder text.
  Pinned skills are gone from request building: `skills_catalog` has no `pinned`, the pinned blocks
  and notices are no longer rendered, and the `pinned_changed` drift reason is removed.
  `model_call.request` requires `tools`, `params`, `absorbedUpToSeq` and `maxOutputTokens`, and
  records `media` with `mediaBudgetBytes`; request building, compaction and the web no longer treat
  a call without `absorbedUpToSeq` as having taken in everything before it, and step replay no longer
  refuses such recordings (`eval.recording_unsupported` is gone).
  Migration 0143 fills those fields on `model_call` rows (and eval snapshots) logged before they
  existed, with the values the old readers assumed: `absorbedUpToSeq` the call's own seq, no tools
  marked `toolsOmitted`, empty `params`, and the default media budget where `media` was recorded.
- 0543a28: A model provider is now on in an organization only when the organization enabled it (its extension
  switch on, or a required bootstrap plugin), like every other extension. A provider an organization
  never enabled is absent from its model lists and catalog and resolves to `agent.model_unavailable`
  ("not enabled in this organization").
  Org readiness (`GET /orgs/:orgId/readiness`, `agents.readiness`, computed once in
  `ReadinessService`) answers `modelProvider: "org_fixable"` with `orgFixableProviders` (each provider
  with its reason: `not_enabled`, or `needs_config` when it is on but waits for the org's own config)
  when an org admin can make a provider the platform offers usable, and `none` when only the super
  admin can help.
- 6d39796: One place to set up a model: the setup checklist, the run row's fix entry and the models pages lead
  to `/admin/models` (super admins: the platform's model services with their deployment config in a
  Sheet, and the marketplace's model services not installed yet with 安装) or `/settings/models` (org
  admins: the model services offered to the org with 启用 and 配置 inline). While the platform has a
  provider the org can turn on or configure (readiness `org_fixable`), the setup step and the page
  guide the org admins (a super admin too, when one of them) to Settings → Models instead of the admin
  console; members wait for an org admin.
- 09965db: Org admins can read their organization's audit log: `GET /api/v1/orgs/:orgId/audit` (keyset paged,
  optional action prefix, never an event's detail), the `orgs.audit` Platform operation and the
  organization settings page 审计日志 / Audit log. The super admin's `GET /api/v1/admin/audit` takes
  an optional `orgId` and both routes an optional `action` prefix.
- a7ce103: Org security settings fail narrow: an unreadable stored `sandboxToolPolicy` reads as `ask` and an
  unreadable scheduled-task `forbiddenTools` list fails unattended runs and refuses new task grants
  (both logged with the org id) until an org admin saves it again; the settings page shows a notice
  and its Save repairs the list, and unrelated settings writes no longer reset it to empty.
- 001648a: Share one run-liveness helper across run queueing, the execution fence, the orphan check and
  deletion, and stop only the live conversations of a deleted organization, recording the
  `org_deleted` stop reason.
- 4c9cc0c: Remove the deprecated UI `place` key, `PLACE_SLOTS`, `UiPlace`, `slotRefOf` and `aliasOf` from the
  plugin SDK: a UI contribution names its `slot`, which is now required. `resolveUiSlots` no longer
  returns `deprecatedPlace`, and `capybara-plugin check` drops the `ui-place-deprecated` rule.
- 8f02aba: Replay guarantees zero drift only for logs written by the current format: the frozen
  release-candidate texts and the drift reasons `legacy_event` and `text_inline_threshold` (a log
  recorded before the 8 000-character text inline threshold) are gone. The line
  restored after a compaction now reads "Skills invoked earlier in this conversation", since it also
  names the template skills the kernel writes at a sub-agent's start.
- e6ac5dc: Honour a provider's retry-after on the same model for up to 5 minutes (and within the run's
  remaining deadline) instead of failing or falling back after 10 seconds.
- 5f9a8a8: Owe a plugin's scope sync from its extension's deploy (enable, upgrade, approval) and the import
  commit instead of a post-deploy add, a delayed backstop and an in-process reconcile wait; fan an
  item's sync out to one job per chunk of orgs, all scope jobs sharing one BullMQ retry policy.
- 3324504: A process that swallowed an unhandled rejection or uncaught exception now answers `/readyz` with 503
  at once, stops gracefully (the SIGTERM drain) and exits with 1, so any restart policy replaces it
  (`/healthz` stays 200).
- 154bfef: Start a template sub-agent with its skills written as skill invocation messages instead of a
  preamble line asking it to load them; the web shows them with the sub-agent's task.
- ee468de: Label the plugin review's npm provenance as an unverified attestation.
- c452bfe: An org's new plugin version applied at once, and the platform's import-and-update, no longer owe
  a scope sync from the import's commit: the update that follows owes it with its own commit. The
  early sync ran while the update moved the extension, installed the old version in the owner org
  mid-update and made the update refuse its own preview (`plugin.upgrade_stale`).
- Updated dependencies [d522c01]
- Updated dependencies [c0a1184]
- Updated dependencies [8f1950d]
- Updated dependencies [4e871ad]
- Updated dependencies [e30fef0]
- Updated dependencies [c122975]
- Updated dependencies [dbfed21]
- Updated dependencies [4992759]
- Updated dependencies [9077604]
- Updated dependencies [3ee2265]
- Updated dependencies [0543a28]
- Updated dependencies [09965db]
- Updated dependencies [a7ce103]
- Updated dependencies [001648a]
- Updated dependencies [2882379]
- Updated dependencies [8f02aba]
- Updated dependencies [e6ac5dc]
- Updated dependencies [5f9a8a8]
- Updated dependencies [0a76603]
- Updated dependencies [3324504]
- Updated dependencies [154bfef]
- Updated dependencies [243734a]
- Updated dependencies [c452bfe]
  - @capybara-hq/kernel@0.1.0-rc.37

## 0.1.0-rc.41

### Patch Changes

- 3385a6d: Chat attachments accept mainstream office documents, archives and source files by extension
  (`attachments.allowedExtensions`, about ninety defaults), because their content types disagree between
  browsers and systems — an `html`, `py`, `ts` or legacy `doc` file could not be attached before. The
  composer's picker offers the extensions and the refusal names them beside the media types.

## 0.1.0-rc.40

No changes in this release.

## 0.1.0-rc.39

### Patch Changes

- 28e692b: Bootstrap pins follow the plugins repository at `05d00a9`: `object-store-s3` 0.1.0-rc.9 → 0.1.0-rc.10
  (it now reports its objects' unsigned URI, so the attachments-on-demand reference reads
  `s3://<bucket>/…`) and `todo` 0.1.0-rc.10 → 0.1.0-rc.11. The compose files' sandbox build contexts
  move to the same commit.

## 0.1.0-rc.38

No changes in this release.

## 0.1.0-rc.37

### Patch Changes

- d9636b0: Setup checklist: when the platform offers a model provider the org can switch on or configure
  (the preinstalled providers are opt-in per org), org admins and super admins go to the org's
  extensions page (model tab) instead of being told to wait for a super admin; readiness gains
  `orgCanAddModel`.
- Updated dependencies [d9636b0]
  - @capybara-hq/kernel@0.1.0-rc.36

## 0.1.0-rc.36

### Patch Changes

- ae01833: Keep IM binding confirmation and cancel disabled until their browser handlers are ready after sign-in.
- fb9afe0: Carry current mode ceilings on local stat and readFile requests so project context loads before
  any command and reads cannot inherit a stale wider command decision. Device protocol v2 requires
  a matching kernel and device upgrade; existing credentials and device files remain valid.
- 50eaf97: Use Webpack in the development web server to avoid repeated Turbopack HMR reloads.
  Preserve design cascade layers when expanding stylesheet imports for Webpack development.
  Make the HTTP login notice conditional on sign-in problems because the browser origin does not
  reveal the server's cookie settings.
- Updated dependencies [c412cf3]
- Updated dependencies [fb9afe0]
  - @capybara-hq/kernel@0.1.0-rc.35

## 0.1.0-rc.35

### Patch Changes

- abf2e18: The sandbox-docker bootstrap pin moves to rc.16 (capybara-hq/plugins 85aaf65): a cloud Docker device
  answers the `list` and `scan` calls, so its projects can be added and scanned from the device page.
  The compose sandbox build contexts point at the same commit.
- a6b1441: An organization's sandbox network follows the platform: it stores the hosts it adds and drops
  (`cloudNetwork: { mode?, base?, extraHosts?, excludedHosts? }`) instead of a copy of
  `sandbox.limits.allowHosts`, and approving a network request adds only the requested hosts, so
  platform changes keep reaching it. The new `sandbox.limits.orgHosts: within` makes the platform
  allowlist a ceiling organizations cannot go beyond (default `extend`). The settings responses carry
  the computed `effectiveNetwork`; `deployment.cloudNetwork` is now `{ allowHosts, orgHosts, off }`.
  Migration 0134 keeps each organization's current list exactly; see docs/deploy/upgrade.md.
- Updated dependencies [abf2e18]
- Updated dependencies [a6b1441]
- Updated dependencies [a5a4c79]
  - @capybara-hq/kernel@0.1.0-rc.34

## 0.1.0-rc.34

### Minor Changes

- 19506a3: Projects: a device's owner adds project directories on the device's 设置 view (suggestions from the
  device, the path relative to the workspace or the home by mode), a new conversation binds one from
  the composer's device menu (自由模式 by default), the conversation header shows the project and
  whether its `AGENTS.md` was loaded or why it is unavailable, and the `/` palette lists the
  project's skills in their own group. The kernel side ships in the same images.

### Patch Changes

- Updated dependencies [19506a3]
- Updated dependencies [4ea1d3f]
  - @capybara-hq/kernel@0.1.0-rc.33

## 0.1.0-rc.33

### Patch Changes

- 220a782: Breaking for route authors: every `permissions.http` entry declares `access` (`public`, `embed`,
  `member` or `admin`) instead of `public?: boolean`. A route handler is called with the caller the
  kernel resolved (`ctx.http.route(method, path, (req, caller) => ...)`, `RouteCaller`); `member` and
  `admin` routes mount under `/plugins/<name>/orgs/:orgId<path>`, `embed` routes live under `/ui/`,
  and an embed contribution's `path` must be declared as a `public` GET. An `embed` caller carries the
  token's `exp` (Unix seconds), so a long-lived handler can end when the token does. The
  `@capybara-hq/testing` fixtures declare access. `capybara-plugin check` fails a manifest whose route
  has no valid `access`, and plugin import refuses it. Existing deployments must re-approve every
  extension that declares routes, because the approved permissions change.
- Updated dependencies [220a782]
  - @capybara-hq/kernel@0.1.0-rc.32

## 0.1.0-rc.32

### Patch Changes

- 5e3cee2: Auto mode correctness (auto mode hardening spec §3, §5). Approving a network request adds its
  hosts without turning an open cloud network into an allowlist. `platform.me` reports a new
  device's mode and network from `effectiveDevicePolicy`. `sandbox.tiers`,
  `sandbox.limits.devHosts` and `sandbox.limits.egress: "open"` in the loaded config now fail
  startup with an error naming `devices.autoMode` and `cloudNetwork`; the startup warning fires when
  the sandbox provider sets `refuseOpenNetwork` while an org can be on the open network. A cloud
  device's owner may send it back to auto (`PATCH /devices/:id { mode: null }`, web session only;
  an API token gets `device.mode_requires_session`), and the device view names the network sandbox
  mode gives it (`mode.sandboxNetwork`). The device page confirms a cloud device's mode switch in
  a dialog naming the network it will reach, and a card that cannot be chosen says why. The
  open-network refusal text is provider-neutral.
- 54d9c50: The sandbox-docker bootstrap pin moves to rc.15 (capybara-hq/plugins 08074e9): the egress proxy
  refuses the Azure WireServer address and the deployment's `deniedCidrs`, and an open-public
  instance made before `refuseOpenNetwork` is recreated. The compose sandbox build contexts point at
  the same commit.
- d8bddcf: OAuth discovery, client registration and token requests, npm registry downloads (packument,
  tarball, a marketplace's `tarball` URL, the bootstrap download) and npm provenance now go through
  the kernel's network rules (`packages/kernel/src/net`): a host must resolve to public addresses
  unless `marketplaces.allowPrivateHosts` lists it, the connection is pinned to the checked address,
  redirects are never followed, and https requests tunnel through `net.httpsProxy`. An OAuth URL
  whose host is private fails with reason `address_refused` and says how to allow it. The configured
  `packages.npmRegistry` origin stays trusted (an internal or `http://` registry keeps working); a
  deployment with `net.httpsProxy` and an internal https registry lists it in `net.noProxy`.
  
  Migration: `NODE_USE_ENV_PROXY=1` / `HTTPS_PROXY` no longer route these requests (the kernel sets
  its own connection). A deployment that relied on them sets `net.httpsProxy` instead, and lists an
  internal https npm registry in `net.noProxy`.
- 7e71aed: A call to a tool that the step's request did not load (ToolSearch mode) now carries a display-only
  `not_loaded` view. It is expected behaviour — the kernel tells the model to load the tool with
  `ToolSearch` and the model retries — so the conversation shows it as a neutral "需先加载工具" /
  "Load the tool first" notice instead of a failure, and the tool group's header no longer counts it
  as failed. The model-facing result is unchanged (`isError: true`, the same message).
- Updated dependencies [5e3cee2]
- Updated dependencies [54d9c50]
- Updated dependencies [96d1df3]
- Updated dependencies [1dce2fe]
- Updated dependencies [aef5036]
- Updated dependencies [d8bddcf]
- Updated dependencies [7e71aed]
- Updated dependencies [d3ba1d8]
  - @capybara-hq/kernel@0.1.0-rc.31

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
