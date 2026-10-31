# Web order: one shell, three frames, two contexts

- Status: implemented (2026-10-31)
- Canvas: https://claude.ai/artifact/UDaSLEyGqqtGP8TXsndoJq ("Capybara 页面秩序": home, Agents, org settings /
  members, admin / extensions, conversation, the shared sidebar). The canvas is the visual reference; this
  document is the rule set.
- Builds on: `docs/design/spec.md` (tokens, components, templates), the UI refresh
  (`2026-10-22-ui-refresh-design.md`), and the rc.2 acceptance changes on `fix/rc2-acceptance` (locale
  cookie, account submenus, theme toggle, org chooser, overview page).

## 0. Why

A walk through every page at rc.2 (35 pages, light, dark, phone) showed that each page works on its own but
the whole has no order:

- Five or six page frames: list pages left-aligned at 1440 (content width 1080 does not fit beside the
  sidebar), the admin area alone uses three frames (inner sub-nav, breadcrumb only, filter rail), and
  breadcrumbs appear on a few pages only.
- "Settings" mixes personal items (my connections, remembered grants, IM identities) with org items
  (general, members, extensions, plugins, model purposes); "扩展", "企业目录" and "模型" exist in two places with
  different scopes and the same names.
- The sidebar's first level lists every page flat, daily work and rare configuration alike, and leaves
  little room for the conversation list, the thing people use most.
- Everything is a table, empty states included; filter rails with a dozen options for two rows.

The goal is order in our own style (E 终端, refined): borrow the discipline of a mature product (contexts,
one page head, few frames), not its look.

## 1. Principles

1. **One shell.** Sidebar, content, status bar. Nothing else frames a signed-in page.
2. **Two contexts.** The workspace (one org at a time) and the admin console (the whole deployment). The
   sidebar says which one you are in and changes as a whole.
3. **One page head.** Path line, title with count, one line of description, actions on the right with at
   most one primary.
4. **Three frames.** Object list, detail / form, settings (with a sub-nav). Plus the special templates that
   already exist for their jobs (overview, conversation, inbox, trace, wizard, auth, status, onboarding).
5. **Objects as rows, records as tables.** Things people own and configure are object rows; logs and
   people lists are tables.
6. **Color is state.** Accent = primary action and current place; warn = needs attention; fail = failed;
   ok = healthy. Nothing else is colored.
7. **The path is the thread.** The page's path line and the status bar's prompt are the same path
   (`capybara / agents / 研究助手` ↔ `grant@capybara:~/agents/研究助手`); that is where the terminal tone
   lives, not in decoration.

## 2. The shell

### 2.1 Sidebar, workspace context (canvas "侧边栏组件", work)

Top to bottom, every block on an 8 px rhythm (the sidebar's padding is 12 / 8 / 8; the account row has 8 px
above its divider and 8 px below):

1. **Brand row**: pixel capybara + `CAPYBARA`, then two icon buttons at its right end (acceptance round
   2): **搜索** (magnifier, "搜索 ⌘K", opens the command palette) and **收件箱** (a link to `/inbox` with a
   small count badge only while something is pending; accessible name "收件箱，3 项待处理").
2. **Org switcher**: a 40 px bordered block on `bg`: the org's initial on `ink`, its name, and
   `~/<slug> · <role>` in mono; the chevrons open the org menu (the user's orgs as radio items, then
   "创建组织…" when allowed). This is the only place the current org is shown and switched.
3. **Primary items**: 新会话, 首页, Agents, 更多 (search and the inbox moved to the brand row).
4. **更多** opens a **flyout menu to the right of the sidebar**, anchored to its row: 技能, 连接器, 插件,
   渠道, 评测与运行, 组织设置, then the org's extension pages after a separator. 渠道, 评测与运行 and
   组织设置 are shown to org admins only (as today); members see 技能, 连接器, 插件. The 更多 row is
   active while the current page is one of its items (that item is marked current in the flyout).
   Enter / Space / → open it, Escape closes it and returns focus. Nothing is remembered; it never
   opens by itself.
5. **Conversations** take the rest of the height and scroll on their own:
   - A section label `会话` with a filter button (search by title, filter: running / waiting / all).
   - Groups by agent, most recent first; a group header (agent name, collapse caret, `＋` = new
     conversation with that agent); the collapsed state is remembered per org (as today).
   - Rows: a 6 px state dot only for running (ok) or waiting for me (warn), the title (ellipsis), and on
     hover / focus / current a `⋯` menu: 改名, 归档, 删除.
   - "再显示 N 个" at the end of a long group; `已归档 · N` at the end of the list swaps the list **in place**
     for the archived conversations (a header "← 已归档 · N" returns; rows offer 取消归档 and 删除; the
     filter applies to it too). No separate page.
6. **管理后台** (enterprise admins only), with an outward arrow: enters the admin context.
7. **Account row**: avatar + name (opens the account menu: 切换组织 ▸, 语言 ▸, 个人设置, 退出登录) and the
   theme toggle (light / dark radio) after it.

In the rail (below 1280) the brand row is the logo alone; search and the inbox are rail icons at
the top of the rail; 更多 opens the same flyout.

### 2.2 Sidebar, admin context (canvas "管理后台 · 扩展")

1. Brand row.
2. **Context block**: the same size and light style as the org switcher, static (no chevrons): a shield in
   the accent tint, "管理后台", and `整个部署 · /admin` in mono. Below it a link "← 回到工作区 ~/<slug>".
3. **Items**: 概览, 账号, 组织, 扩展, 企业目录, 市场, 模型, 部署设置. No conversations.
4. Account row.

### 2.3 Content area

- Background `bg`; content centered, `max-width: 1120px`, side padding 32 px (16 px below 640 px), top 20 px.
  Every frame uses this width; nothing is left-aligned with an empty right half any more.
- The **status bar** (24 px, mono) stays at the bottom of the content column: left the prompt
  `<login>@<org-slug>:<path>` (`/admin/...` in the admin context), right version and time zone; the
  conversation page adds tokens and cost.
- The conversation page keeps its own layout inside the shell (§3.5).

### 2.4 Page head (every frame)

1. **Path line** (mono 12 px, `faint` with the last segment in `ink`): `<scope> / <page> [/ <sub>]`, where
   scope is the org slug (`capybara`), `~` for the home page, or `/admin`. Earlier segments are links.
2. **Title row**: h1 (20 px / 600) + count in mono `faint` when the page lists things; actions on the right
   (at most one primary; a secondary and an overflow menu at most).
3. **Description**: one line in `muted`, optional.
4. **Tabs with counts** (optional) right under the head when the page has views (全部 6 · 我的 3 · 组织共享
   3), with the search input at the right end of the tab row.

## 3. Frames

### 3.1 Object list (canvas "组织 · Agents")

For things people own and configure: Agents, 技能, 连接器, 插件 (org catalog), 渠道, 评测集, admin 扩展, admin
企业目录, 市场 entries, org 已安装的插件.

- One panel (`panel`, 1 px `line-soft`, radius 8) holding rows split by `line-soft`.
- **Object row** (min 64 px): a 36 px mark (initials in mono on `selected`, or the object's icon; tinted
  warn when it needs attention), then
  - line 1: name (600; mono for package names) + scope / kind chips (`仅自己`, `组织共享`, `必需`) + an
    attention chip when relevant (`回退模型不可用`);
  - line 2: one-line description in `muted`;
  - line 3: mono metadata in `faint` (`deepseek-chat · 4 技能 · 6 工具 · 沙箱`);
  - right: a state label in mono with its color (`● 已启用`, `◆ 待配置`), or the last use time; one row
    action button (the most common action: 对话 / 配置 / 安装) and an overflow menu.
- **Needs attention first**: a warn callout above the tabs names what needs action, with its button
  (canvas admin / extensions). Filter rails go away; tabs with counts replace them (a tab only when it
  holds something different from 全部).
- **Empty**: the one empty state (§3.7), never a table header over an icon.
- **Loading**: the head keeps its real layout (title, actions, tabs with a muted "–" for counts,
  search); only the rows are skeletons (acceptance round 2).
- **Marketplace entries** are object rows too (mono name, summary, meta = marketplace · source ·
  version · permissions with the sensitive count in warn, state 未引入 / 已引入 <version>, one action
  引入 or 查看, the rest in the menu); the search is the head's; the marketplaces are a second tab row
  above the list only when there is more than one (the head's tab row holds 浏览 · 市场源).

### 3.2 Record table

For records: 成员, 账号, 组织 (admin), 运行记录, 已记住的授权, 部署申请, IM 身份. The existing `DataTable`
inside the same panel style, same head and tabs; rows 44 px with mono for times and ids. Admin lists that are
records stay tables; when they need actions they keep the row menu.

### 3.3 Detail / form

Agents new / edit (with a **渠道** section, §3.3.1), skill detail, connector detail and install (wizard), channel new / edit, eval set new /
detail / run, catalog item and install, admin extension detail and install, catalog import. The page head
(path ends with the object's name), then the existing FormPage sections (label column + controls) inside the
1120 width, the ActionRow above the status bar for unsaved changes (as today).

#### 3.3.1 Channels on the agent

A channel connection already belongs to one agent (`channel_connections.agent_id`). The agent edit page
gets a 渠道 section listing the connections bound to it (kind, name, state) with "接入渠道", which opens
the channel form with the agent preset and returns to the agent afterwards. The section is shown to users who may manage channels (org admins);
members see none, because the kernel's channel list requires `channels.manage`. The 更多 · 渠道 page stays as the org-wide list.

### 3.4 Settings (canvas "组织 · 设置 / 成员")

For a set of settings pages under one title: **组织设置** (`/settings/*`) and **个人设置** (`/account/*`).

- Page head: path `capybara / 设置 / 成员`, h1 "组织设置" (or "个人设置") + description.
- Below it, inside the content width: a 200 px sub-nav (group labels in mono, items 30 px, current item on
  `sidebar-active`, counts in mono) and the section content.
- Section content: its own h2 + description + actions row, then forms (settings sections) or a record table.
- The admin console has no inner sub-nav: its pages are in the sidebar (today's inner nav on admin models /
  settings / marketplaces is removed).

### 3.5 Conversation (canvas "对话页")

- Title bar 48 px: path `capybara / <agent> /` + title + state (`◆ 等你审批`), icons on the right.
- The thread scrolls on its own; the composer is **fixed at the bottom** of the 720 px column, above the
  status bar, never part of the scrolling thread.
- Everything else as the conversation spec (tool groups, approvals, right panel).

### 3.6 Overview, setup and empty states

- Home (`/`): the overview from rc.2 acceptance (#9) in the shell above: waiting for you (tabs with counts),
  pick up where you left off (state labels), your agents, the org at a glance.
- **One setup checklist** (org / model / agent, each with the action this viewer may take), drawn by the
  setup layout (§3.8) on `/` and `/chat` while the org is not ready; the shell's home and new-conversation
  pages no longer draw it.
- One empty state (§3.7), one loading state (skeleton in the frame's shape, never shaped like one of
  two possible outcomes), one error state with retry.

### 3.7 Empty state (acceptance round 2)

One component everywhere (`EmptyState`, design spec §6.18): the pixel capybara drawn in faint lines,
one sentence in ink saying what will be here, an optional muted second line, and the action that
fills it. Two sizes: `page` (centered in the content frame, generous space) for list pages and the
inbox, `compact` (left-aligned, small illustration) for the DataTable's empty area, panels and the
sidebar's conversation list ("还没有会话" + 新会话; a filter matching nothing: "没有匹配的会话" +
清除筛选). An inbox with nothing in it is one full-width empty state, not a list + detail split
around an empty table.

### 3.8 Setup layout (acceptance round 2, user decisions D and D2)

A third layout beside the auth layout (sign-in, initialization, the org chooser) and the shell: the
**setup layout** (`SetupPage`, design spec §5.5), drawn while the current org is not ready
(`setupReady(agents, providers)` is false for this viewer: no usable model or no agent).

- **Frame**: no sidebar; a 48 px top bar (pixel capybara + `CAPYBARA`; at the right the current org
  with its menu when there are several orgs or creating one is allowed, the account with 语言 ▸ /
  个人设置 / 退出登录, the theme toggle); a centered column; the status bar
  (`<login>@<slug>:~/setup` on the setup home, the pathname elsewhere).
- **Scope**: every workspace route while not ready. `/admin/*` keeps the admin console context (that
  is where an enterprise admin configures the model provider); the auth screens and the org chooser
  keep the auth layout.
  - `/` and `/chat`: the **setup home**: path `<slug> / 开始之前`, h1 开始之前, "还差几步才能开始对话", the
    checklist card ("开始之前 · 已完成 n / 3"), then "可以稍后再做" with only what the viewer can act
    on. The org summary card of the old overview is dropped.
  - Step pages render their normal content in the setup frame (content width) under a back link
    "← 开始之前": `/settings/models`, `/settings/members`, `/agents/new`, `/agents/<id>`,
    `/channels/new`, `/catalog`, `/catalog/<id>`, `/catalog/<id>/install`, and `/account/*`.
  - Any other workspace route is replaced by `/`.
  - Readiness is read again on every navigation while in setup; once ready the next navigation draws
    the shell. Creating the agent that makes the org ready re-reads readiness and lands on
    `/chat?agent=<id>` in the shell.
- **Deciding the layout**: until the session and the readiness are known a workspace route shows only
  the neutral PendingState (design spec §6.20): never the shell first and then the setup layout. A
  failed readiness read counts as ready (the shell's pages report their own errors); an org switch
  keeps a ready shell until the new org is read. The server render of a workspace route is the
  neutral state too.
- **Roles** (cosmetic; the kernel decides):

  | Step | Enterprise admin | Org admin | Member | Guest |
  |---|---|---|---|---|
  | Model | 去配置 → `/admin/extensions` | 去配置 → `/settings/models` when the deployment has a provider but the org no usable model; else "需要部署管理员配置模型服务" | "等待管理员配置模型" | same as member |
  | Agent | 新建 → `/agents/new` once a model exists; before that disabled with "先配置模型" | same | same | "等待管理员创建 agent" |
  | 可以稍后再做 | invite members, channels, plugins (when also an org admin) | invite members, channels, plugins | 我的连接 | — |

  A viewer with nothing to do right now also sees "组织还在配置中，管理员完成后你就能开始对话" and a
  刷新 button that re-reads readiness.

## 4. Where every page goes

| Today | Context · place | Frame | Route |
|---|---|---|---|
| 概览 `/` | work · 首页 | overview | `/` |
| 新会话 `/chat`, `/chat/:id` | work · 新会话 / conversations | conversation | unchanged |
| 收件箱 `/inbox` | work · 收件箱 | inbox | unchanged |
| Agents | work · Agents | object list / detail | unchanged |
| 技能 | work · 更多 · 技能 | object list / detail | unchanged |
| 连接器 | work · 更多 · 连接器 | object list / detail / wizard | unchanged |
| 企业目录 (org) `/catalog` | work · 更多 · **插件** | object list / detail | unchanged (label "插件") |
| 渠道 | work · 更多 · 渠道 | object list / form | unchanged |
| 评测 `/evals`, 运行记录 `/trajectories` | work · 更多 · **评测与运行** (tabs 评测集 · 运行记录) | object list + record table | unchanged |
| 设置 · 组织设置 | 组织设置 · 通用 (+ 沙箱 split out) | settings | `/settings/organization`, `/settings/sandbox` |
| 设置 · 成员 / 扩展 / 已安装的插件 / 模型用途 | 组织设置 · 成员 / 扩展 / 插件 / 模型 | settings | unchanged |
| 设置 · 我的连接 / 已记住的授权 / IM 身份 | **个人设置** (account menu) | settings | `/account/connections`, `/account/grants`, `/account/identities` (old paths redirect) |
| 管理 `/admin` | admin · 概览 | overview | unchanged |
| 账号 / 组织 | admin · 账号 / 组织 | record table | unchanged |
| 扩展 (+ install, detail) | admin · 扩展 | object list / detail | unchanged |
| 企业目录 (+ import, requests, item) | admin · 企业目录 (tabs 插件 · 部署申请) | object list | unchanged |
| 市场 (sources + entries) | admin · 市场 (tabs 浏览 · 市场源) | object list + form | unchanged |
| 模型 / 部署设置 | admin · 模型 / 部署设置 | form (no inner nav) | unchanged |

Language and theme stay where #9 put them (language in the account menu, theme after the account).

## 5. Functions the sidebar needs

| Function | Today | Needed |
|---|---|---|
| Rename a conversation | `PATCH …/conversations/:id` | the `⋯` menu item and an inline edit |
| Archive / unarchive | none | `conversations.archived_at` (expand-only migration), `PATCH` `{ archived }`, lists exclude archived by default, `?archived=1` for the in-place archived list (with a count); archiving does not stop a running run |
| Delete | none | soft delete (`deleted_at`, `DELETE …/conversations/:id`, stops a running run first): hidden everywhere for the owner and from org lists, kept for audit; org roles holding `trajectories.read` still see it through the trajectory audit path (decided 2026-10-31); hard deletion stays out of scope |
| Search / filter | `?agentId` only | `?q=` (title, case-insensitive substring) and `?state=running|waiting` on `GET …/conversations` and `…/groups` |
| Org menu "创建组织…" | done (#10) | — |

## 6. Design system changes

- **Sidebar v3** (`packages/design/src/shell/sidebar.tsx`): org switcher / admin context block props,
  brand-row search and inbox buttons, primary items, a "更多" flyout menu, conversation groups with collapse, `＋`, row state dots, the
  `⋯` row menu, "再显示 N 个", archived entry, filter button; the admin entry above the account row.
  `docs/design/spec.md` §6.13 rewritten; the reference set re-rendered for the sidebar.
- **PageHeader**: a `path` (segments with optional hrefs) replaces `breadcrumb`; one form for every frame.
- **Content width**: one width token for frames (`layout.content` 1120) replacing list 1080 / form 880 inside
  the shell (forms keep their label column inside it).
- **ObjectList + ObjectRow** components (§3.1), a **SettingsFrame** (sub-nav + content), an **EmptyState**
  and a **Callout** (attention) component; `ItemList` / `StepList` from #9 fold into these where they overlap.
- **Templates**: ListPage takes `variant: "objects" | "records"`; SettingsPage becomes the settings frame;
  admin pages lose their inner nav.
- `check:web-ui` gains a rule: a page under `src/app/(app)` other than the conversation and auth pages
  renders exactly one PageHeader with a `path` (the head is never skipped or hand-built).
- Visual baselines: regenerated through `visual-update` once.

## 7. Out of scope

- A different visual direction (tokens, fonts, brand stay).
- Hard deletion of conversations, sharing conversations, folders / pins (later, if asked).
- The mobile layout beyond what the shell already does (drawer below 960).

## 8. Decisions (2026-10-31)

1. 渠道, 评测与运行 and 组织设置 under 更多 are for org admins only; channels are also managed from each
   agent's settings (§3.3.1).
2. The archived list swaps the sidebar's conversation list in place; no `/chat/archived` page.
3. Soft-deleted conversations stay visible through the trajectory audit path to org roles holding `trajectories.read`.
