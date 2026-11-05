# @capybara-hq/web

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
