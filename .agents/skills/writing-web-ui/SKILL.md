---
name: writing-web-ui
description: 'Use when adding or changing UI under apps/web or packages/design: page = page template + design components, pages on the query cache (thin server page.tsx + client view.tsx, TanStack Query: keys, freshness classes, defineQuery, the route table and its prefetch, usePageQuery, useWorkspace / useAdmin, useAppMutation invalidation, renderRouteWithCache / renderRouteEmptyCache, template loading shapes), which template each page uses, the skeletons for ListPage + DataTable and FormPage + FormSection + ActionRow, what check:web-ui forbids (className / style / .css / color literals / low-level UI packages), the change flow for adding a component or template, how to use /dev/ui and screenshot tests (visual-update), and the web side of client extensions (ClientHost, ReplaceableSlot, the data-cap-part literal rule, CSS layers, the CSP nonce, safe mode).'
---

# Writing UI

Spec: `docs/design/spec.md` (the only spec). Implementation: `packages/design` (`@capybara-hq/design`); `apps/web` only consumes it.
The visual source is the **reference set** in `docs/design/reference/` (one PNG per component state, dark and light, drawn in `docs/design/reference/src/` from `docs/design/tokens.json`, the real fonts and `@capybara-hq/design/fixtures`; signed off 2026-10-26). New work is accepted against it (spec §9). The `/dev/ui` catalog and the committed screenshot baselines (`apps/web/visual/`) then guard against breakage.

Tokens: `docs/design/tokens.json` is the source; `pnpm gen:tokens` writes `tokens.css` / `tokens.ts` (never edit them), `pnpm check:tokens` checks them. Sizes are steps of the spec §2.5 scales; a container picks the density step (`density="dense" | "default" | "prominent"`, or `DensityContext`), pages never pick sizes.

## Core rules

**Page = template + design components.** `apps/web` writes no styles: no `className`, `style`, `.css` or color literals; lay out with `Stack` / `Grid` / `Card` / `Text`, and colors come only from design tokens. When a component is missing, add it to the design package first (see "Adding a component or template" below); don't improvise one in a page.

**Type, figures and details** (spec §2.2, §6.5, §6.17, §6.18). A sentence is prose: `Text variant="prose"` for hints, notes, descriptions and dialog bodies (field help, object descriptions, callouts and empty states already are); mono stays for ids, paths, numbers, versions and dates. A date is `<DateTime value={iso} />` (`YYYY-MM-DD HH:mm`, the relative age on hover) or `formatDateTime(iso, form, useTimeZone())` inside a string; never `toLocaleString`. Anything that reads the clock or the zone in render takes `useNow()` / `useTimeZone()` (`formatRelative(iso, locale, useNow())`, `untitledLabel(d, locale, useTimeZone())`, a running time `useNow(1000)`), never `Date.now()` / `new Date()`: they hydrate with the server render's clock (`DesignProvider` `clock`, set by the root layout) and switch to the browser's after, so a server-rendered time never fails hydration. A version is `versionLabel(v)` ("v0.1.0"), but request bodies keep the bare version. An `ObjectRow` mark is `{ text: <display name> }` (drawn as its upper-cased initial), never an icon for an object; a thing a plugin brings (a channel, an extension, a model provider) adds its plugin's icon, `image: <kernel icon URL>` (`mark.image`, `ObjectCard avatar={{ image }}`, `CellTitle image`, `ItemList` row `mark`, `Sheet mark`, `ObjectMark`), which falls back to the initial (spec §6.17, maintainer decision 2026-11-08). Plain metadata (visibility) is meta or muted text, never a badge; internal ids such as model purpose ids are never shown. `EmptyState` has three styles, chosen by the space it fills (spec §6.18 "Where"): `page` (the capybara) for a page or settings content area with nothing to show, `panel` (a small capybara, centered) for an empty region inside a box (a card, a form card, a Sheet, a Dialog, a right panel, a properties section; an `ItemList`'s `empty` draws it), `compact` (words only) only for the DataTable's one-line area. Never a bare `Text` sentence as an empty state.

**One box is enough** (spec §1 principle 7, §2.5; acceptance item AB). Inside a box (a `Card`, a
`FormSection`'s card, a `Sheet`, a `Dialog`, an `InlineCard`, a `PropertySection`) group with
headings, hairlines and space, never a second `Card`, `FormSection`, `ObjectList` or `StatCards`:

| Inside a box you want | Use |
|---|---|
| A list of things, each with lines or fields (purposes, quick actions, inline sub-agents, permission groups) | `<FormSection flush>` + `<ItemList label inset="flush">` of `<ItemListItem title code? marks? actions? meta?>{fields}</ItemListItem>` (`inset="card"`, the default, inside a padded box) |
| A nested group of fields (a config object, an advanced group) | `<Subsection title description?>` (h3, help, fields under the 1px guide) |
| Several tables in one card | `<FormSection flush>` + one `<Subsection variant="flush" title>` per table, each holding a `DataTable` (unframed by itself) |
| A list beside the open item's fields | `<Grid columns="list-detail" divided>`, the open item's name as `<Text variant="h3">` over its fields, no Card |
| A notice about the section | the `Callout` above the section card; a `Callout` inside a box (a Dialog, a Sheet, a panel shared by a page and a Sheet) draws the warn / fail line with its icon by itself |
| A choice of sources in a Dialog | `RadioGroup variant="card"` and the one `FilePicker` straight in the body, no Card |

`DataTable`, `CodeBlock`, `EmbedFrame`, `Repeater` and `Callout` draw their unboxed form inside a
box by themselves (unframed, borderless, divided rows, a warn / fail line); don't pass `framed`
there. Option cards, form
controls, the FilePicker in a Dialog and a `RightPanel` are the exceptions. `pnpm check:web-ui`
(`web-ui-box-in-box`) enforces it on apps/web's JSX (components, consts, helpers, hook render
functions and slot props are followed; `BOX_PENDING` in `tools/checks/src/box-in-box.ts` is empty
and new code adds no entry); `findNestedBoxes` (`@capybara-hq/design/reference`) checks the
rendered DOM in tests.

**Icons are components.** Use `<Icon name="search" size={14} />` (or an `IconButton` with an `Icon` and an `aria-label`) from `@capybara-hq/design`; never a character as an icon (`▾ ✓ ✕ ⋯ ⠿ ▤ ●`…; rule `design-char-icon`) and never an icon library in `apps/web`. A missing icon is added to `packages/design/scripts/gen-icons.mjs` (`pnpm --filter @capybara-hq/design gen:icons`).

## Choosing a template (spec §5)

| Page | Template | Notes |
|---|---|---|
| Agent summary, admin overview | `OverviewPage` | Single (the workspace has no home page: the new conversation at `/` is the home; `/chat` redirects permanently to `/` with its query, maintainer decision 2026-11-07) |
| Agents / knowledge bases / extensions / members lists | `ListPage` | Rail (optional facet filters) + one `DataTable` |
| Agent / knowledge base / extension detail | `DetailPage` | Content + Inspector, with PageTabs |
| Create / edit an object | `FormPage` | Centered, grouped by `FormSection`, always has an ActionRow |
| Org / environment / security settings | `SettingsPage` | Secondary nav + Centered, ActionRow when there are changes |
| Human approval, alert handling | `InboxPage` | Rail + Content (+ Inspector) |
| The conversation page (`/` for a new one, `/chat/<id>`) | `ConversationPage` | Title bar + thread + composer, with the properties panel or one right panel (spec §5.4) (it replaced `PlaygroundPage`); a new conversation (`/`) passes `newConversation` with `Greeting` and `AgentRow`, and the composer has no agent picker and takes the agent's `QuickActions` (a `zap` menu after the effort picker) |
| Single run detail | `TracePage` | Span waterfall + detail |
| First-time setup of a model / connector / extension | `WizardPage` | Centered + step bar, previous / next |
| Login, initialization, accept invitation | `AuthPage` | No Shell |
| 404 / 403 / under maintenance | `StatusPage` | Single, centered |
| New org, empty environment | `OnboardingPage` | Single, centered checklist |
| The workspace while the org has no model or no agent | `SetupPage` | The shell's geometry with the setup sidebar (`context.kind: "setup"`: 开始之前 and the steps as navigation) + content area + status bar; the page brings its own template; drawn by `AppFrame` (`components/shell/setup.tsx`), never by a page (web-order spec §3.8, web-SSR spec §4) |

### The web order: contexts and frames (spec `docs/superpowers/specs/2026-10-31-web-order-design.md`)

The sidebar has three contexts (the third, setup, is drawn only by `SetupPage`): the workspace (新会话, which is the home, then 智能体 / 技能 / 连接器; 更多 with plugins / extensions / channels / evals / org settings (agent templates are the 模板 tab of 智能体, ruling P4-14); the conversations) and the admin console (`/admin/*`, entered from the account row, super admins only). Personal settings are `/account/*` (connections, grants, IM identities), org settings `/settings/*`. Every page uses one of three frames and one page head (`PageHeader`: `path` required, `title`, optional `description` / `actions` / `tabs` + `activeTab` / `search`).

| Frame | Template | Use |
|---|---|---|
| Object list | `ListPage` with `variant="objects"`: `ObjectRow` children inside one `ObjectList` (mark, name + chips, description, mono meta, state, one action, row menu) | Things a person picks and opens: agents, skills, connectors, evals, catalog, admin catalog, marketplace entries (the 扩展 pages are a record list by capability with a Sheet, spec §5.1) |
| Card list | `ListPage` with `variant="cards"`: `ObjectCard` children in one `CardGrid` on the page ground (avatar or icon, name as the one stretched link, two-line description, meta line, one dense primary, ⋯; roving focus by row; spec §6.34) | Things a person picks by look and starts from: the workspace 智能体 page's 智能体 / 模板 tabs, the admin 智能体 / 模板 tab's template list (ruling P4-15), the org 渠道 page (maintainer decision 2026-11-08: plugin icon, name, platform, agent · unbound mode, state) and, with the same `ChannelCard`, the agent page's 渠道 section (a `CardGrid` under its own heading on the SettingsPage ground, no section card) |
| Record list | `ListPage` with `variant="records"` (default): a `DataTable` | Tabular records: members, accounts, orgs, trajectories |
| Detail / form | `DetailPage` (Content + Inspector, `PageTabs`) / `FormPage` / `WizardPage` | One object; create or edit; multi-step setup |
| Settings | `SettingsPage` with the grouped secondary nav | Org settings, personal settings, deployment settings |

- `ListPage` takes `listLabel` (the list's accessible name), `callout` (a `Callout` between the title row and the tabs) and `empty` (an `EmptyState`, drawn instead of the rows: loading failed, nothing yet, no match). Use these instead of drawing your own notices; an object list is a `ul` (role `list` / `listitem`), not a table.
- A failure whose cause is raw system text (a kernel message, a network error) is an `ErrorDetail`: one sentence in the reader's language mapped from the error, the raw text behind its 「原始错误」 toggle; never the raw English inline. A button that navigates is a `LinkButton` (a link drawn as the button), never a bare text link among buttons.
- Create forms and dialogs (spec §5.3, §6.7): a new object's page is `FormPage create` (focus on the first field, no 「没有未保存的修改」), and its primary is `disabled` until the form is valid; a dialog that asks for input starts on its first field by itself. When the prerequisite is missing (no channel extension for 新建渠道) draw only the `EmptyState` with the next step, never the form. A dialog that can only explain (退出组织 as the only owner) is not `danger`: one 「知道了」; a dialog whose next step lives elsewhere offers it as a `LinkButton` primary, never a disabled dead end. Picking a file is the `FilePicker` drop zone (spec §6.25), with card radios (`RadioGroup variant="card"` in a `Card`) to choose between sources.
- Model purposes (`components/PurposeEditor`, `usePurposeDrafts`): the rows have no save of their own; the page has one ActionRow that saves every changed purpose. A row shows the purpose's label (never its id); a kernel purpose has one muted hint saying what happens while it is unset, an extension's purpose 「来自 <display name>」; on the org page the deployment default rides on the select's default option 「使用部署默认（…）」.
- `ObjectRow.action` is the row's most common action (a link when it has `href`), `menu` holds the rest; the menu button is named 更多操作.
- A header's `path` comes from `usePagePath("org" | "home" | "admin", ...)`; `web-ui-page-path` rejects a page head without it.

### Templates for the admin console, evals and the catalog (ready-made M6 examples)

| Page | Route | Template |
|---|---|---|
| Admin console overview (StatCards, the 4th 近 7 天运行 from the usage query, a dash until it answers; then one `OverviewSection` per part, each on its own query with its own loading / error / 重试; 运行状况 is not prefetched and polls with `refetchInterval` every 30 s; 用量 is not prefetched, its key holds the reader's zone from `useTimeZone()`, a `TrendChart` with one panel per measure and an unframed ranking `DataTable`) | `/admin` | `OverviewPage` |
| Accounts, orgs, extensions (tabs by capability, a Sheet per extension with its deployment config, actions and folded permissions; spec §5.1), plugins (one head with the tabs 已安装 / 市场 / 待确认: installed plugins, marketplace entries, permission confirmations and org requests), marketplace sources, the platform audit log (加载更多 by cursor) | `/admin/accounts`, `/admin/orgs`, `/admin/audit`, `/admin/extensions`, `/admin/plugins`, `/admin/plugins/market`, `/admin/plugins/pending`, `/admin/plugins/sources` | `ListPage` |
| Extension detail, plugin detail (tabs 组件 / 组织 / 版本; 设置范围 and 停用 open `PluginScopeDialog` / `PluginDisableDialog` with the impact preview) | `/admin/extensions/[name]`, `/admin/plugins/[itemId]` | `DetailPage` (summary / permissions / config etc. use PageTabs) |
| Platform components: 技能 and 连接器 / 智能体 template lists (来自, 归属, 范围, 版本, orgs using it; the 智能体 template list is cards (source · owner · scope · v, 查看, ⋯ with the scope, disable and 对其他组织显示 actions; ruling P4-17)) and details (tabs 版本 / 组织; 设置范围 opens `ComponentScopeDialog` with 跟随插件, 停用, 上传新版本 for skills and agent templates); the plugin detail's 更新到 x opens `PlatformUpdateDialog` (the per-component update preview, confirmed with `diffHash`) | `/admin/skills`, `/admin/connectors/templates`, `/admin/agents/templates`, `/admin/themes` and their `[id]` | `ListPage` / `DetailPage` |
| Admin 智能体 / 连接器 (the items orgs created, across orgs): header tabs 智能体 / 模板 and 连接器 / 模板; the 模板 tab holds the platform and org-created templates with the owner filter 全部 / 平台 / 组织创建 (`useOwnerFilter`). Lists: `/admin/agents` and `/admin/connectors` (`ListPage` + `DataTable`, org filter), `/admin/connectors/templates` (`ListPage` + `DataTable`), `/admin/agents/templates` (`ListPage` `variant="cards"`); details: `/admin/agents/[id]`, `/admin/agents/templates/[id]`, `/admin/connectors/[id]`, `/admin/connectors/templates/[id]` | the eight routes listed | `ListPage` / `DetailPage` |
| Install an extension, plugin import review (上传插件包; its confirm step asks for the scope) | `/admin/extensions/install`, `/admin/plugins/import` | `WizardPage` |
| Deployment settings (外观: the platform default theme), models and prices | `/admin/settings`, `/admin/models` | `SettingsPage` |
| Trajectory list / eval set list | `/trajectories`, `/evals` | `ListPage` |
| Trajectory detail, eval case | `/trajectories/[conversationId]`, `/evals/[setId]/cases/[caseId]` | `TracePage`: `waterfall` holds `SpanWaterfall`, `detail` holds the selected span's detail |
| Eval set, eval run | `/evals/[setId]`, `/evals/runs/[runId]` | `DetailPage` |
| Create an eval set / start a run | `/evals/new`, `/evals/[setId]/run` | `FormPage` / `WizardPage` |
| Workspace 插件 (state, 启用 / 组织配置 / 停用 with the switch-off preview, requests, the 市场 tab for org admins), plugin detail (this org's installs: clean-up; a platform plugin moves only with the admin update), the input wizard 启用 opens | `/plugins`, `/plugins/[itemId]`, `/plugins/[itemId]/enable` | `ListPage` / `DetailPage` / `WizardPage` |
| Workspace 扩展 (a DataTable with tabs by capability, `?tab=`, and a search; each row's switch, which is its plugin's; a row opens a Sheet with the org config, the state and the folded permissions; default providers; file previewers; members read the states only, without config, secrets or permissions; spec §5.1 "The 扩展 pages") | `/extensions` | `ListPage` + `Sheet` |
| Workspace 技能 (the org's own rows and the platform components offered to the org, with state and the org admin's per-component switch; members read only) | `/skills` | `ListPage` |
| Workspace 智能体 with the tabs 智能体 / 模板 (`?tab=templates`; cards: an agent's 开始会话 and ⋯ 设置 / 运行记录 / 另存为模板 for org admins (the owner is changed on the agent page only), a template's 用它创建 and ⋯ 查看 or 编辑 / 可共享 / 删除 for owner-org admins, plus the org admin's switch; spec §5.1 "The 智能体 page and the template cards"); `/agent-templates*` redirect there | `/agents` | `ListPage variant="cards"` |
| The template page (the agent page's section frame: the read view for members, the editor for owner-org admins, each save a new version; 用它创建 the primary, ⋯ 可共享 / 删除; a platform template off in the org is the OverviewPage with 未在本组织启用 and the switch) and the 另存为模板 dialog (agent page and agent card ⋯, org admins; spec §5.1 "The template page and 另存为模板") | `/agents/templates/[id]` | `SettingsPage` |
| Workspace 设备 (the person's devices; a row opens the device page. The device page's head is the `DeviceNameplate` band — name, origin, state light, mode mark, program version — the page's one bright element; below it the facts each said once, `DeviceModeSection` (the 自动 / 沙箱 `ModeScale`, one sentence per mode, the `capybara-device mode` keycaps for a local device, and the network block in sandbox mode only), the recent mode changes, and for a local device its machine block) | `/devices`, `/devices/[id]` | `ListPage` / `DetailPage` |
| Platform inbox (org requests, permission confirmations, scope sync failures, a failed migration run; each links to the page where it is acted on; sidebar count) | `/admin/inbox` | `InboxPage` |

- Admin console views start with the gate `useAdmin()` (`lib/query/workspace.ts`): for non-super-admins the view returns `<NoAccess need={gate.need} />` (`components/NoAccess`, the `StatusPage` no-access state), and the route table prefetches nothing from `/api/v1/admin/*` for them (a UI-level block; the kernel is the final authority). Org views do the same with `useWorkspace()`. The UI always says "super admin".
- **`SpanWaterfall`**(spec §6.10)takes only plain props (`spans`, `selectedId`, `onSelect`, `labels`, `label`): each span's `kind` (`run` / `step` / `model` / `tool` / `wait`), `startMs` (relative to the earliest span), `durationMs` (null if unknown), `status`, `parentId`; the caller passes them in depth-first order. The page computes time and cost from the data the kernel returns (latency is derived from event times; cost is labeled "estimated").
- The org and platform 外观 (`/settings/appearance`, `/admin/settings`) also hold the arrangement of extension UI after the theme: `UiReplacementsSection` (替换) then `UiPlacementSection` (界面位置) from `components/UiArrangementSection`; `/extensions` only links there.
- The three 外观 levels (`/account/preferences`, `/settings/appearance`, `/admin/settings`) pick a theme with `components/ThemePicker` (the design `ThemeSwatchGroup` in the page's scheme; the built-in theme draws `BUILTIN_THEME_SWATCHES`); a platform default change runs `invalidatePlatformTheme` (every cached org's themes). A preview that takes a theme away renders its `themes` block with `useThemeImpactGroup` (`components/ThemeImpact`).
- Permission review (install confirmation page, org extension settings, plugin review) shares `components/PermissionReview`; the purpose mapping shares `components/PurposeEditor`. Don't draw a second copy in a page.
- **Auto mode's places** (auto mode spec §4.3): the org settings page `/settings/sandbox` holds the org's auto-mode switch (`autoMode`, following the platform / on / off) and its cloud network (`cloudNetwork`: 开放挡内网 or an allowlist with hosts); `/admin/settings` holds the platform's `devices.autoMode`; the device page `/devices/[id]` holds `DeviceModeSection` (`components/DeviceModeSection.tsx`) with the design package's `ModeScale` and `DeviceNameplate`. The device page never widens a mode: 自动 sends nothing (only the machine turns auto on), 沙箱 narrows through the policy op (local) or `PATCH` (cloud), and the scale is locked once sandbox. A cloud network in auto mode is read-only 开放（挡内网）; in sandbox mode a local device's allowlist is edited on the device page and a cloud device's network comes from the org setting. `sandbox.open_network_refused`, `device.auto_mode_not_allowed` and `device.mode_on_device` have `errors.*` copy; add new error copy there rather than inline.
- After the main table, a `ListPage` may carry a subordinate block (an `h2` + one `DataTable`, e.g. invitations on the members page); see spec §5.1.
- Phones (below 640, spec §4.3) are the design package's job, never a page's: every `DataTable` stacks its rows (the first column is the card's title, the others `header value` lines, so give every column a real `header`), StatCards go 2 × 2, tabs scroll, tap targets are 40 px (compact buttons through an invisible ring), the conversation page loses its minimum width, `ObjectRow`s go compact (⋯ on the name line, the state at the end of the meta line, the action at its right), the page head stacks (description wrapping, actions under it), a SettingsPage sub-nav sticks under the head, and the sidebar drawer lists 更多 in place and scrolls its middle as one region. Pages add no narrow variant of their own: give `ObjectRow` its `state` and `action` as usual and the design package lays them out.

### The conversation page

- **Pages never group tool calls themselves.** `apps/web/src/lib/timeline.ts` is the one pure builder that turns conversation events into timeline items (user bubbles, prose, thinking, tool groups, human-in-the-loop cards, file outputs, inline cards, sub-agent groups, dividers): consecutive tool calls become one group, a group ends at prose, a user message, a card or a divider, prose is never folded into a group. It is unit-tested with recorded logs, including a log written before UI refresh B (no `description`, no `view`, no title) that must render without errors.
- The page passes plain data to the design components of spec §6.16 (`ToolGroup`, `ToolRow`, `Prose`, `ApprovalBlock`, `FileCard` …) and keeps the container logic (`useConversation`, cards with API calls) in `apps/web`. Tool rows read titles, kinds and key arguments from `GET …/conversations/:id/tools?keys=…` (`lib/tool-info.ts`), never by parsing tool keys.
- Copy: "文件" / "files" for what an agent delivers, never "产出物" / "artifacts"; tool verbs per kind come from the design i18n (spec §7).
- Extension blocks (inline card, properties section, right panel, previewer) fail alone: "Failed to load · Retry" in that block, the stream and the composer keep working.
- The right area lives in the URL hash (`lib/right-area.ts`: `#properties`, `#panel=<plugin>/<contribution>[/<item>]`, `#file=`, `#output=`, `#subagent=`), one thing at a time, so a reload keeps it and another conversation never inherits it. Back in a sub-agent panel returns to what was open before it (e.g. the properties panel), else closes. The properties sections render in the spec §6.16.17 order (Context, extension sections, Files, Background tasks); Files includes the sub-agents' deliveries, marked with the sub-agent.
- A new conversation (`/`) creates nothing on the kernel before the first send.
- Phones (below 640) on the conversation page are the design package's (spec §4.3, §5.4, §6.16.2):
  the new conversation pins the composer at the bottom with the greeting and a sideways-scrolling
  agents row at the top; the page passes the agent's quick actions twice, as the composer's
  `QuickActions` and as `newConversation.quickActions` (a `QuickActionList`, listed on a phone, the
  same `onPick`); the composer collapses its device / model / effort pickers into one options
  button and bottom sheet by itself (pass the pickers as usual). On a touch device
  (`isTouchPointer()`, read at the tap) a choice never focuses the composer, and a quick action
  fills it without focus. The shell lifts the conversation column above the iOS keyboard
  (`--cb-keyboard-inset`); pages add nothing for it.
- A card whose state the log does not carry (a sub-agent's approval or question, named only by id)
  reads it before the first paint (`openWaitReads` in the route's `then`) and draws nothing until
  that read answers (`ApprovalCard fromRead`), never a pending card first (web query cache spec §6).

### Setup guides (spec `docs/superpowers/specs/2026-11-09-setup-guides-v2-design.md` §7.3, §9, §10.4)

- One component for every place: `apps/web/src/components/SetupGuideSection.tsx` (v1's
  `SetupGuideBody` is gone). It reads the guide the kernel rendered (`setupGuideQuery` /
  `adminSetupGuideQuery` in `lib/query/setup.ts`, types in `lib/setup-guides.ts`) and draws the
  drift notice and ack, the title, a `Segmented` mode switch when the guide has more than one mode
  (starting at the target's mode), the design `GuideDocument` (prose through `Markdown`, copyable
  `CodeBlock`s with titles, `CheckRow`s) and a muted line per `unresolved[].reason`. The web never
  parses guide Markdown or directives and never substitutes variables: the kernel sends blocks.
- It draws no box: the page puts it in its section card (a `FormSection` or a `Card`); the drift
  notice is a line in it. The connector places are in `components/ConnectorGuides.tsx`
  (`TemplateGuideSection` above a template's input in the wizards, the member's 如何连接 `Sheet` on
  `/account/connections`, with a link to the admin guide for org admins).
- Checks: without a saved target the rows are static ("checked after saving"); `checks="live"` with a
  target reads the cached states (`setupCheckStatesQuery`), runs the rows without a fresh result
  (at most 4 at a time, no `force`), polls once a second while a row is `running`, and 重新检查
  runs with `force` (the kernel's cooldown answers `cooldownUntil`). Reasons and fixes are plain
  text in the UI language (`zh` falls back to `en`).
- 让智能体协助 / Ask an agent opens the new conversation with a draft (`draftConversationPath`),
  never sent. Secrets stay in their fields on the page; the composer warns before sending
  token-like text.

Submit actions go in the ActionRow (built into `FormPage`, `WizardPage` etc.) and **must not** go in the PageHeader; at most one `variant: "primary"` per view, and at most 5 metrics (`PageHeader` throws in development and tests).

## Pages and the query cache (spec `docs/superpowers/specs/2026-11-03-web-query-cache-design.md`)

Every network read of the web app goes through TanStack Query (`@tanstack/react-query`). A first
load (a document request: opening a URL, a reload) is rendered on the server with its data and
paints complete; later navigations inside the app are client-side and read from the query cache.
A client navigation never runs the layout: a fresh entry makes no request, a stale one paints and
refreshes in the background, an uncached one shows the template's `loading` state.
The web-SSR spec (`2026-11-01-web-ssr-design.md`) still holds for the frame, the gates and session
changes; this spec replaces its "server page reads, view gets `initial`" model.

Every route is two files:

```
app/(app)/agents/page.tsx      server, thin: reads nothing, passes the route params to the view
app/(app)/agents/view.tsx      "use client": the gate, the reads (useQuery), the template
```

```tsx
// page.tsx (no "use client"; no kernel read: web-query-page-read)
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentView id={id} />;
}

// view.tsx
"use client";
export default function AgentsView() {
  const ws = useWorkspace();                  // admin pages: useAdmin()
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Agents orgId={ws.orgId} />;
}

function Agents({ orgId }: { orgId: string }) {
  const list = usePageQuery(agentsQuery(orgId));
  if (list.kind === "notFound") return <NotFound />;           // the segment's not-found.tsx
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  if (list.kind === "loading") return <ListPage header={header} variant="objects" loading />;
  return <ListPage header={header} variant="objects">{/* rows of list.data */}</ListPage>;
}
```

**The query layer** (`apps/web/src/lib/query/`):

- `client.ts`: one `QueryClient` per browser tab, one per server request (`lib/server/query.ts`,
  React `cache()`). No retry for a 4xx `ApiClientError`, at most one for `network`,
  `upstream_unavailable` and 5xx; `refetchOnWindowFocus: false`, `refetchOnMount` and
  `refetchOnReconnect` on; `gcTime` is TanStack's default. A signed-out 401 `auth.*` (after the
  refresh retry) clears the cache and goes to `/login?returnTo=<path>`.
- `keys.ts`: the only place keys are built (`web-query-keys`). Every key starts with its scope:
  `["org", orgId, …]`, `["account", accountId, …]` (`keys.account("self")` only for `me` /
  `maybeMe`), `["deployment", …]`. Add a builder next to its area's others; a key holds everything
  the answer depends on (route params, search params, the UI locale), so each filter set is its
  own entry.
- `freshness.ts`: each read names a class, never a number (`web-query-freshness`): `mine`
  (`Infinity`: `/me`, my tokens, identities), `orgConfig` (30 s: agents, models, connectors,
  skills, members, settings), `live` (30 s: inbox, conversation groups, queue, files, sandbox),
  `events` (`Infinity`: a conversation's log, which the stream appends to), `deployment` (30 s:
  the admin console), `unclassified` (0, the default nobody should keep).
- `define.ts`: hook-free, because server layouts import it (`next build` rejects a server
  component that reaches a client hook; vitest and tsc do not). `defineQuery({ key, fn, freshness })` is the one way to declare a read, in
  `lib/query/<area>.ts`, wrapping the existing `lib/<area>.ts` loader (`fn` gets `{ signal }`).
  The same options object serves the server prefetch and the client hook; `useQuery({ ...q,
  enabled })` / `select` are fine. Views and components never call a kernel loader outside a
  `defineQuery` / `useAppMutation` `fn` (`web-query-no-direct-read`); pure helpers and the SSE
  opener are allowed.
- `routes.ts`: the route table, one entry per `page.tsx` under `(app)` / `(auth)`
  (`web-query-route-table`; patterns are string literals): `queries(ctx)` returns what the first
  paint needs from `ctx` (`params`, `search`, `me`, `orgId`, `locale`), gated like the view (a
  page a guest may not open reads nothing for a guest); `then(ctx, qc)` prefetches reads that need
  the first wave's answers (what the loaded agent's connectors name); `none: "<reason>"` for a page
  that reads nothing. `(app)/layout.tsx` and the `(auth)` layout run `prefetchRoute` for
  `currentPath()` beside the shell reads and dehydrate the cache (failed reads too, with their
  kernel code, so the view draws the error or not-found state on the first paint and does not read
  it again on mount). A client navigation never runs the layout.
- `page-query.ts`: `usePageQuery(q)` turns a page's main read into `loading` / `ready` (with
  `refreshing`) / `notFound` (a 404 wins even over cached data: an object deleted elsewhere is
  not shown) / `error` (`code`, `retry`; a failed background refetch keeps the cached data).
  Secondary sections are their own `useQuery` with their own section state (`retryOnMountOf`
  keeps a hydrated error from being read again on mount).
- `workspace.ts`: `useWorkspace({ min?, setup? })` / `useAdmin()` are the client gates, decided
  from the cached `/me` and readiness (`pending` until they answer; a route without `setup` goes home,
  `/`, while the org is not ready). `resetSession(qc, then)` cancels every read in flight, clears
  the cache and navigates in the same task: an org switch, create or leave and a sign-out go
  through it, then a full navigation (ruling R4), so nothing of the old org or account paints.
- **Mutations** are `useAppMutation({ fn, invalidates: (v, r) => [keys…], forgetsOnLeave?, onSuccess? })`
  from `lib/query/mutation.ts` (a `"use client"` hook module; any `lib/**` module importing a
  `use*` hook starts with `"use client"`, `web-lib-client-hook`): the
  listed keys are invalidated (awaited) before `onSuccess`; use `qc.setQueryData` where the answer
  is the new object. A delete that leaves its detail page lists the detail's keys in
  `forgetsOnLeave`: they are removed when the page unmounts (removing them earlier would read them
  again and flash not-found before the navigation), so Back never paints the deleted object. No
  `router.refresh()` after a mutation, except one that changes what the layout decided (org,
  readiness, sign-in), which goes through `resetSession`.
- **Polling** is `refetchInterval` on the query, never a hand-written timer. **Persistent
  components** (the sidebar's groups, the inbox count) stay mounted, so they refetch their stale
  queries on each path change themselves. The conversation's SSE stream appends to the cached
  events (`appendEvents`, unique and ordered by `seq`) and its `changed` frames invalidate the
  matching keys; on return it reopens from the cached last seq.
- **Live drafts and the composer** (run input spec 2026-11-07). Sending while a run is active is an
  interjection (`POST …/messages`, ↵ or ⌘↵); there is no queue UI, the bubble is placed where the run
  absorbed it (`待处理` until then) and only paused leftovers from before keep 继续发送. A streaming
  reply is a draft: after a reload or a conversation switch the page shows the current draft from the
  stream's `event: draft` frame (sent after the catch-up) and resumes from it; `GET …/runs/:runId/draft`
  only fills a gap the deltas reveal (`lib/stream.ts`, `lib/live-drafts.ts`); never the draft and its
  final message both.

**Status codes.** A missing object (a 404 read) is the page's not-found state inside the shell
with HTTP 200; an unknown route keeps `notFound()` and its 404 (`(app)/[...rest]/page.tsx`); the
kernel unavailable on a first load is the `KernelStarting` frame.

**Recipe for a page** (what every page of the migration did):

1. One `defineQuery` per kernel read in `lib/query/<area>.ts`, keys in `keys.ts`, the class from
   the table above.
2. The route entry: `queries(ctx)` with the first-paint reads, `then` for the dependent ones (or a
   dependent `useQuery` with `enabled` in the view when the first paint does not need it).
3. `page.tsx` reads nothing and passes the params; `view.tsx` gates with `useWorkspace` /
   `useAdmin`, reads with `usePageQuery`, passes the template's `loading` shape while it is
   `loading`, renders the segment's not-found component for `notFound` and the existing error
   state with `retry` for `error`.
4. Mutations through `useAppMutation` with their `invalidates`; polls as `refetchInterval`.
5. Tests (below), then `pnpm check:web-ui` and `pnpm exec vitest run apps/web/test/<file>`.

**Template loading states** (spec §7.1, `docs/design/spec.md` §5): a navigation to a page with
nothing cached draws the page's frame with skeletons in the loaded page's own boxes, so nothing
moves when the data lands. Pass the shape the page knows statically; a template guesses nothing:

- `ListPage loading`: `true`, or `{ rows?, stats?, table?: { label, columns, rowHeight?, framed? },
  keep? }` (`keep`: the children are the page's own sections, each loading for itself).
- `FormPage loading` (boolean) with `FormSection loading={{ fields: n | FieldShape[] }}` or
  `{{ items: ItemShape[] }}` (item rows in a flush card); `LoadingFormSection` when the section's
  title is not known either.
- `SettingsPage loading={{ sections?: [{ fields?, items?, title?, description? }], cards? }}`
  (`cards`: a stack of titled cards on the page ground, no section).
- `DetailPage loading={{ inspector?: true | { rows?, keyWidth? }, blocks?, content?: BlockShape[] }}`
  and `WizardPage loading={{ fields }} | {{ content: BlockShape[] }}`.
- `OverviewPage loading={{ stats?, sections?, keep? }}` (`keep`: the children don't depend on the
  data).
- `InboxPage loading`, `TracePage loading={{ spans?, stats? }}`, `AuthPage loading={{ fields }}`,
  `ConversationPage loading={{ thread?, title?, rightArea? }}`, `PageHeader loading`.
- Shapes (`templates/frame.tsx`): `FieldShape` (`control`: `input` / `textarea` / `select` /
  `segmented` / `radio-cards` / `radios` / `key-value` / `switch` / `text` / `item-group` /
  `list-editor`, plus `help`, `rows`, `pair`, `options`, `keyWidth`), `ItemShape` (`lines`,
  `lineSize`, `field`, `buttons`, `actions`, `list`), `BlockShape` (`lines` / `list` / `key-value` / `buttons` / `table` /
  `card`). Parts already cached render for real; only the missing parts are skeletons. One busy
  region per page (`aria-busy`); reduced motion draws static bars. `PendingState` stays for
  in-place loading after a person's action, never for navigation.

**Rules kept from web-SSR**: no `loading.tsx` (`web-ssr-loading-file`), no `"use client"` page
(`web-ssr-client-page`), params and query from the server props (`params`, `searchParams`, passed to the view), never
`window.location` during render (`web-ssr-location`; `// ssr-exempt: <reason>` covers a false
positive), a server page imports only the default export and types from `./view`
(`web-ssr-view-value-import`). Next's `staleTimes` is not configured, and Next's internal request
headers (`RSC`, `Next-Router-State-Tree`) are never read. `QUERY_PENDING` and `SSR_PENDING`
(`tools/checks/src/web-ui.ts`) are empty ratchets; new pages are never added to them.

**Tests** (`apps/web/test/support/query.tsx`):

- `renderRouteWithCache(path, routes, opts)`: a document load: the layout's prefetch (`/me`,
  readiness, the route's entry) runs against stubbed kernel routes on the server, the cache is
  dehydrated through JSON and the page renders inside the hydration boundary; `navigate(to)` is a
  client navigation under the same layout. Pair it with `expectNoFirstPaintFetch()` to assert the
  first render makes no browser read. `renderAuthRouteWithCache` is the same for `(auth)` pages.
- `renderRouteEmptyCache(path, routes, opts)`: a client navigation with nothing cached (or a
  seeded `opts.client`): the views read through `stubApi`; hold a route to assert the template's
  `aria-busy` loading state, then the data.
- Every page has the cases "a first render from the hydrated cache makes no browser read" and
  "an empty cache shows the template's loading state, then the data", and each mutation one
  "<mutation> invalidates <keys>" asserting the refetch.
- `apps/web/e2e/query-cache.spec.ts` counts the browser's `/api` GETs: back to a conversation
  within 30 s reads only its stream, after 30 s it paints at once and refreshes in the background,
  a rename updates the sidebar with one groups read, an org switch never shows the old org, a
  reload paints with no skeleton and no browser read, a navigation to an uncached page shows the
  template's loading state.

## Skeleton examples

List (`apps/web/src/app/(app)/agents/page.tsx` + `view.tsx` are a real example; the page, the gate
and the reads are shown under "Pages and the query cache" above):

```tsx
// view.tsx
"use client";

import { ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";

function Agents({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("agents");
  const list = usePageQuery(agentsQuery(orgId));
  const header = {
    path: [...scope, { label: "agents" }],
    title: t("title"),
    actions: [{ label: t("new"), variant: "primary" as const, href: "/agents/new" }],
  };
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  if (list.kind === "loading") return <ListPage header={header} variant="objects" loading />;
  const agents = list.data.agents;
  return (
    <ListPage
      header={header}
      variant="objects"
      listLabel={t("title")}
      {...(agents.length === 0 ? { empty: { text: t("empty") } } : {})}
    >
      {agents.map((a) => (
        <AgentRow key={a.id} agent={a} />
      ))}
    </ListPage>
  );
}
```

Form (real examples: `agents/new/page.tsx`, `components/AgentForm.tsx`):

```tsx
import { Field, FormPage, FormSection, Input, Select } from "@capybara-hq/design";

<FormPage
  header={{
    path: [...scope, { label: "agents", href: "/agents" }, { label: "new" }], // scope = usePagePath("org")
    title: t("agents.form.title"),
  }}
  actionRow={{
    unsaved: dirtyCount,
    errors: errorCount,
    cancel: { label: t("common.cancel"), onSelect: back },
    primary: { label: t("agents.form.submit"), onSelect: submit, loading: pending, disabled: !canSubmit },
  }}
>
  <FormSection id="basic" title={t("agents.form.basic")} description={t("agents.form.basicHint")}>
    <Field label={t("agents.form.nameLabel")} required error={nameError}>
      <Input value={name} onChange={(e) => setName(e.target.value)} />
    </Field>
  </FormSection>
</FormPage>
```

`PageHeaderProps`: `{ path, title, description?, count?, status?, metrics?, actions?, tabs?, activeTab?, search? }` (`path` is required: `usePagePath("org" | "home" | "admin", ...segments)` from `components/shell/path.ts` gives the scope, then add the page and object segments; metrics become StatCards, drawn by the template; `tabs` with counts and the `search` field form the head's last row). Forms have no anchor navigation; the error count lives in the ActionRow. `ActionRowProps`: `{ unsaved?, errors?, cancel?, secondary?, primary }` (`unsaved: 0` reads "No unsaved changes"); button spec `{ label, onSelect, shortcut?, loading?, disabled? }`. For the exact props of the controls in the examples, `packages/design/src/controls` and `/dev/ui` are authoritative (`Field` passes the aria associations for label, help and error to its child control). Use `useStatusBar(...)` for page status text; `useToast()` for toasts; in-app links go through the `DesignProvider` `link` (apps/web already passes next-intl's `Link`).

UI text goes through next-intl (`apps/web/messages/{zh,en}.json`); text inside design goes through design's own i18n.

## Forbidden (maps one-to-one to the `pnpm check:web-ui` rules)

Rule implementation: `tools/checks/src/web-ui.ts`; every rule has a violating-fixture test.

| Rule id | Forbidden | Use instead |
|---|---|---|
| `web-ui-import` | Importing blacklisted packages: `@radix-ui/*`, `cmdk`, `@emotion/*`, `@stitches/*`, `@vanilla-extract/*`, `@mui/*`, `@chakra-ui/*`, `@mantine/*`, `@headlessui/*`, `styled-components`, `antd`, `tailwindcss`, `tailwind-merge`, `clsx`, `classnames`, `class-variance-authority`, `styled-jsx`, `lucide-react`, `react-icons`; importing any `.css` other than `@capybara-hq/design/styles.css` | Use components exported by design; if one is missing, add it to the design package first |
| `web-ui-class-name` | `className` / `class` attributes (including `{...{ className }}` spreads and the props object of `createElement` / `jsx`) | Use design components or `Stack` / `Grid` / `Card` / `Text` |
| `web-ui-style` | `style` / `dangerouslySetInnerHTML` attributes, `<style>` elements (spreads and `createElement` included too) | Same as above; when new styles are needed, add them to the design package |
| `web-ui-iframe` | `<iframe>` elements, `createElement("iframe")` | Use `EmbedFrame` (sandbox fixed to `allow-scripts allow-forms`, forwards only this iframe's `message`) |
| `web-ui-color` | Any color notation: `#hex`, `rgb()` / `rgba()`, `hsl()` / `hsla()`, `hwb()`, `lab()` / `lch()` / `oklab()` / `oklch()`, `color()`, `color-mix()` | Colors come only from design tokens |
| `web-ui-css-file` | a `.css` file under `apps/web/src` | Put styles in `packages/design` |
| `web-ui-template` | a `src/app/**/page.tsx` that renders none of the 12 templates "imported from `@capybara-hq/design`" | Pick a §5 template as the skeleton |
| `web-ui-page-path` | a `header` of a page template (all but `ConversationPage`, `AuthPage`, `OnboardingPage`, `StatusPage`, `TracePage`, `InboxPage`) in a `src/app/(app)/**/page.tsx` without a `path` property, or one the rule cannot follow (reported as "cannot be confirmed statically"): no literal `path` beside a spread, an imported or called value, a spread element without `header` | Pass `header={{ path: [...scope, { label }], title }}` inline or as a same-file const object literal; a page that builds its header elsewhere passes `path` and `title` through and writes the literal itself (see `WizardView`) |
| `design-char-icon` | A character used as an icon (`▾ ▴ ▸ ◂ ✓ ✗ ✕ ◐ › ‹ « » ● ○ ⠿ ▤ ⋯ ↻ ↗ ↕ ▲ ▼ ‖ ⊘ ◆ □ ■ ▶ ∅ ☰ ⚙ ⌕ ▦`) in a string, template literal or JSX text of non-test code in `apps/web/src` or `packages/design/src`, or in a value of `apps/web/messages/*.json`; the message names the icon to use. Box-drawing (`─ │ └`), `⌘`, `↵`, `→`, `·` and `…` are text and allowed | `<Icon name="chevron-down">` (or an `IconButton` with an `Icon`, `Text icon="circle-x"`, `MenuItem.checked`); keep the accessible name in text or `aria-label` |
| `web-ui-extension-label` | A provider / extension label built by hand that shows the extension id: a template literal that puts `<…>.provider` (or `provider`) before ` / `, or one holding such an expression as the value of a `label` property or JSX attribute (spaced or not), outside `lib/extension-label.ts`; option values (`value:`, encode helpers) stay allowed | `extensionLabel(x, locale)` / `modelLabel(provider, model, locale)` from `apps/web/src/lib/extension-label.ts` (the display name in the page locale, else the id) |
| `web-ui-box-in-box` | A boxed design component (`Card`, `FormSection`, `DangerZone`, `ObjectList`, `LinkCard`, `StatCards`, `InlineCard`, `CardGrid`, `ObjectCard`, `FilePicker` outside a Dialog) inside a box (`Card`, `FormSection`, `Dialog`, `Sheet`, `Popover`, `InlineCard`, `PropertySection`, `Callout`, `DangerZone`, `ObjectList`), directly, in an attribute or through an apps/web component, a `const`, a helper, a hook's render function or a wrapper's slot prop that draws one (portals reset the box); a `DataTable` in a non-`flush` FormSection; a `framed` CodeBlock / EmbedFrame / DataTable inside a box. `web-ui-box-stale-pending`: a `BOX_PENDING` entry (`{ path, inner, max }`, empty since AB wave 2) with fewer findings than its `max` | `ItemList` / `ItemListItem` rows, `Subsection`, a `flush` FormSection, the Callout above the box (see "One box is enough") |
| `web-ui-form-method` | A `<form>` (or `createElement("form")`) without a literal `method="post"`, in `apps/web/src` or `packages/design/src`: without the client JS a native submission is a GET with every field (passwords too) in the URL | `<form method="post" onSubmit={...}>`; the proxy answers a native POST (`lib/form-post.ts`: sign-in and setup server side, a 303 back elsewhere) |
| `design-color-literal` | `#hex` / `rgb()` / `hsl()` in `packages/design/src` outside `styles/tokens.css` (both CSS and TS strings are checked; `color-mix()` referencing tokens is allowed) | Define a token in `tokens.css` and use `var(--cb-…)` |

`web-ui-template` has two exemptions: `app/dev/**` (the development catalog page; the other rules still apply), and pages that only handle 404 -- containing no JSX and calling `notFound()` imported from `next/navigation` (e.g. `(app)/[...rest]/page.tsx`), where the page is rendered by the `StatusPage` in the `not-found.tsx` of the same segment. Don't use this exemption to write other pages.

`web-ui-iframe` is a static check and only recognizes literals: `<iframe>` and `createElement("iframe")`. It cannot see dynamic tags (`const Tag = "iframe"; <Tag />`, `createElement(tag)`, names assembled for `document.createElement`), but the rule applies all the same -- don't work around it this way; review treats it as a violation.

Test files (`*.test.*`) are not checked. The package import rule is a blacklist: when introducing a new style / UI dependency, add it to `FORBIDDEN_PKG`.

**First paint follows the window through CSS.** `useMediaQuery` reads `false` on the server and during hydration, so a layout chosen only in JS (rail vs full sidebar, a Sheet vs an inline panel) is drawn in its wide form until the first client render. Below the breakpoint, CSS media queries must already give the narrow first paint (the sidebar draws both variants and shows one; the conversation page hides its inline right area below 1280 until it becomes the Sheet). A "no horizontal page scroll" check that samples before that render fails only under load; pin the first paint with a JS-off case (`test.use({ javaScriptEnabled: false })`, see `apps/web/visual/conversation.interaction.spec.ts` and `sidebar.interaction.spec.ts`).

## Client extensions in the web app (`apps/web/src/components/client-ext/`, spec `2026-11-09-client-extensions-design.md`)

The behaviour, routes, delivery and safety rules are in [writing-extension-ui](../writing-extension-ui/SKILL.md) (client code section); this section is what a web or design change must keep.

- **Where things live.** `ClientHost` (the workspace layout's client component: sets `globalThis.__CAPYBARA_CLIENT_HOST__`, imports the entries, keeps the registry, applies the crash budget and reports, polices the plugin stylesheets, turns a client navigation across the workspace / admin boundary into a document load), `ClientExtensionsHead` (server: import map, entry preloads, plugin stylesheets), `events.ts` (client events derived from the conversation log), `run-state.tsx` (the run-state context `ConversationView` publishes into), `host-api.ts` (what the `@capybara-hq/plugin-client` hooks read). The host's export list and `CLIENT_API_VERSION` are a generated copy of the package (`pnpm gen:plugin-client`, `check:plugin-client-api`); the shims in `public/_capybara/client-host/` are generated by `pnpm gen:client-host` (the e2e and visual harnesses run it; the server warns when the manifest is missing).
- **Slots.** Component contributions render only through `<ExtensionSlot>`; `ClientComponentBlock`, `ReplaceableSlot` and `ReplaceableFrame` appear in JSX only in `components/extension-ui/` (`web-ui-extension-slot`). A replaceable single slot is `<ExtensionSlot slot="shell.brand" args={{ orgId }} host={{ builtin, ... }} />` in its one owner file; the built-in is always passed (it is the fallback, the pending render and the safe-mode render, so the first client render equals the server render and hydration never mismatches). When the shell lists a delivered winner the server renders the built-in pending (hidden in `ReplaceableFrame`, whose CSS alone reveals it after 1 500 ms). The design `Sidebar` takes `brand` as a function of the panel it is drawn in (`{ collapsed, panel }`), called once per drawn panel. The composer frame passes `builtin` (framed) and `children` (the inputs without the frame); the winner must render `children` exactly once or the host falls back (`ReplaceableSlot` checks, after every commit and DOM change in the frame, that the slot holds exactly one composer textarea; a portal out of the frame counts as dropping it). A component in a list slot is drawn inside the host's frame (section, panel, card), so the slot's owner passes the frame, not the plugin.
- **`data-cap-part`.** A built-in element a plugin may style carries a literal `data-cap-part="<name>"` (a string literal or a conditional of literals; `check:ui-parts`: `ui-part-literal`, `-undeclared`, `-owner`, `-unrendered`), in a file the part's `owner` list names. Add the part to `UI_PARTS` in the SDK (bumping `version` for a rename or removal), run `pnpm gen:ui-parts`, and add the literal in the owner file. `data-part` stays internal (tests, design CSS). The shell element also carries `data-cap-state` (`AppShell` `capState`: `run=`, `theme=`, `sign-in=new`, `motion=`; the shell appends `sidebar=rail|full` after hydration); a new token needs the spec §7.3 and the skill updated. No styles go into `apps/web` for any of it: the overlay (`DecorationLayer`), the pending frame (`ReplaceableFrame`) and the safe-mode banner (`SafeModeBanner`) are design components (design spec §4.5).
- **CSS layers.** `packages/design/src/styles/index.css` declares `@layer design, theme, extensions;` and imports every stylesheet with `layer(design)`; `renderThemeCss` wraps theme CSS in `@layer theme`; plugin CSS is `@layer extensions`. A new design stylesheet must be imported with `layer(design)`: an unlayered rule would beat every layered plugin rule whatever the order. (Next's own `_global-error.html` style is unlayered; harmless, only the error page.)
- **The CSP nonce.** `src/proxy.ts` creates a nonce per request (`lib/headers.ts`: `newNonce`, `documentPolicy`), sets it on the forwarded request (`x-nonce`, which Next puts on its own scripts and the layouts read) and the CSP on the response; a client-sent nonce or policy never survives. A layout that renders its own inline `<script>` (the import map) must put the nonce on it. New script sources are a CSP change reviewed on its own (`SCRIPT_PATHS`); the policy has no scheme and uses the document host, so a proxy must forward `Host`. `style-src`, `connect-src`, `img-src` stay open.
- **Safe mode and the stylesheets.** Safe mode is the query `?safe-ui=1` or the session cookie `cap_safe_ui` (`lib/client-extensions.ts`: `safeUiOf`, `safeUiCookieFor`), set in the proxy (`HttpOnly`, session) and cleared only by `?safe-ui=0` (the banner's exit navigates there through the proxy); the layout renders no client code and `ClientHost` is pinned to it for the document. The banner is a row of the App Shell (`AppShell` / `SetupPage` take `banner`, `ClientHost` supplies it through `ShellBannerProvider`; never an element above the 100dvh shell). A component page (`org.page`, `platform.page`, `agent.detail.section`) goes through `ClientComponentBody` (skeleton, load-failed with retry, empty state), and nav entries that cannot render are filtered by `useOfferedContributions` / `useOfferedPlatformPages`. After a successful apply of a client plugin's appearance the page reloads (`reloadDocument` in `lib/browser.ts`), and `ClientHost` offers one reload notice when the live set gains client code the document lacks. A crash counts once per contribution per document. The overlay's `DecorationLayer` is not `aria-hidden` itself: it hides only elements that neither are nor hold an interactive element (a MutationObserver keeps that current). Hoisted plugin stylesheets are disabled by `ClientHost` (never removed by React): remember a session-disabled plugin's CSS shows until hydration, and JS-injected plugin styles stay until the next document load.
- **Tests.** Unit: `apps/web/test` (the event mapping table, crash budget, `ReplaceableSlot` fallback / timeout / composer check, safe mode, the proxy CSP); e2e `apps/web/e2e/client-extensions.spec.ts` with the `fake-client` and `fake-client-broken` fixtures (free ports only).

## Extension config forms

Every extension config form (deployment config, org extension settings, channel connections, the
catalog install wizard, the plugin upgrade dialog) is drawn by one renderer, the config-form module
`apps/web/src/components/config-form` (`ConfigForm.tsx` draws a JSON Schema with its `x-ui` hints;
`model.ts` builds the field tree and reads a draft back; `deployment.ts`, `org.ts` and
`channel.ts` adapt each API's view and save body). Don't write another schema form. It is built
only from design pieces: `Repeater` (arrays of objects: item titles, presets, move / remove /
undo; inside the form card its items are divided rows by themselves), `Subsection` (a nested
object: its title as an h3, its help, its fields under the guide; never a `Card`), `FieldRow` /
`FieldRowGroup` (compact rows, e.g. an endpoint's models), `KeyValueEditor` (records,
`maskValues` for secret records). A missing piece is added to `packages/design` through
the steps below, never styled in `apps/web`.

## Adding a component or template

In order, don't skip steps (spec §10):

1. **Change the spec**: `docs/design/spec.md` (components in §6, templates in §5, tokens in §2), with the component's **state list** and **size table** in the spec §9.2 format (`<!-- states: x -->`, `<!-- size-table: x -->`; values are `tokens.json` paths); new tokens go into `docs/design/tokens.json` (then `pnpm gen:tokens`). Add a **reference block** per state to `docs/design/reference/src/` (`data-ref-block="<component>-<state>"`). Get the spec diff reviewed.
2. **Implement**: `packages/design/src/…`, exported from `src/index.ts` (or the `index.ts` of the matching subdirectory); write styles in `src/styles/*.css` with tokens for colors; add tests (`packages/design/test/`, jsdom) covering states, keyboard and aria. A new template must also be added to `PAGE_TEMPLATES` in `src/templates/names.ts` and `WEB_UI_TEMPLATES` in `tools/checks/src/web-ui.ts` (a test keeps the two consistent).
3. **Catalog page**: in `apps/web/src/dev/catalog`, add all states of the component / the full page of the template (fixed fake data from `@capybara-hq/design/fixtures`, light and dark), and a `RefBlock` per listed state with the **same id** as the reference block under `/dev/ui/reference/<component>`. Give the component's elements the `data-part` names the size table uses.
4. **Accept it**: `COMPARE=<component> pnpm --filter @capybara-hq/web compare` builds the reference | implementation side-by-side page (`apps/web/compare-out/index.html`, with `<id>-<theme>.ref.png` / `.impl.png` pairs). The pairs are then judged by a **blind image-reviewing subagent**, dispatched by the controller (the coordinating agent, not the implementer, who knows what changed): it gets only the PNG paths and the instruction "List every difference between each reference (left) and implementation (right) by severity: severe = different structure or layout, missing state, wrong color; moderate = size or spacing off; minor = rendering details. Cite the block id.", never a description of the change. Render the compare in the same Linux Playwright image as the references (`mcr.microsoft.com/playwright:v1.64.1-noble`, against a local `next start`): macOS glyph advances and anti-aliasing differ from Linux, so a macOS compare shows narrow mono text and CJK punctuation that are not real differences. Fix every severe and moderate difference and repeat; list the minor ones in the report. Then add the component to `ACCEPTED` in `apps/web/visual/accepted.ts` so `fidelity.spec.ts` measures it against the size table and checks state coverage (its completeness case fails while a component with a state list in the spec is not in `ACCEPTED`). A difference that is right in the implementation and wrong in the reference goes through the spec §10 change process, never a quiet mismatch.
5. **Update the screenshot baselines**: committed baselines contain only the Linux version, so trigger the GitHub Actions `visual-update` workflow on the PR branch (`workflow_dispatch`, with the branch name as the `branch` input); it generates and commits them inside the pinned Playwright Docker image. The PR attaches the diff images and merges after confirmation. Local darwin screenshots (`*-darwin.png`) are gitignored and only for local comparison; don't commit them.

## How to run

```bash
pnpm vitest run --project design          # component tests of the design package
pnpm check:web-ui                         # UI rule check (already part of pnpm check)
pnpm --filter @capybara-hq/web dev        # development; /dev/ui is the component catalog page
CAPYBARA_DEV_UI=1 pnpm --filter @capybara-hq/web start   # enable /dev/ui in a production build (off by default)
pnpm --filter @capybara-hq/web visual     # screenshot regression (runs next build + start itself; local darwin differs from the baselines, for comparison only)
pnpm --filter @capybara-hq/web visual fidelity      # measuring + state coverage against the spec size tables
COMPARE=button,table pnpm --filter @capybara-hq/web compare   # side-by-side page in apps/web/compare-out/
pnpm --filter @capybara-hq/web reference:render     # render the reference set PNGs locally (look only; CI commits them)
pnpm --filter @capybara-hq/web e2e        # real-stack e2e (Testcontainers, needs Docker)
```

Before changing `apps/web`, read `node_modules/next/dist/docs` (see `apps/web/AGENTS.md`; Next 16 has breaking changes).
