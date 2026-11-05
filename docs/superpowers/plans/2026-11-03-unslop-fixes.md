# Unslop audit fixes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** fix every P1–P3 finding of `docs/design/audits/2026-11-03-unslop-full.md` (IDs U1–U8 and the
grouped P2/P3 lines), plus the user's width decision below.

**Spec:** the audit file is the requirement list; `docs/design/spec.md` (incl. §7.1 Copy) and the web
rules in AGENTS.md / `.agents/skills/writing-web-ui/SKILL.md` bind every task.

## User decisions (2026-11-03)
- Fix all of P1–P3.
- **One width rule for every page**: every page template is capped at `layout.content` (1120),
  centred, and is 100% wide below that; the same side padding (`layout.content-pad`) and the same
  page-head position everywhere. This replaces the full-width templates (inbox, trace — trajectory
  and eval case/run detail —, onboarding, status pages). The conversation page keeps its own columns
  (720 chat column + right panel).

## Global constraints
- Worktree `/Users/grant/Capybara/core/.claude/worktrees/fix-rc2-acceptance`, branch
  `fix/rc2-acceptance`. Identity `Grant <284885069@qq.com>`; Conventional Commits in English; body
  lines ≤ 100; end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push only when the
  controller says so (implementers never push).
- `apps/web` writes no styles; visual changes go through `packages/design` (component + spec.md size
  table/states + catalog/reference block + `apps/web/visual/accepted.ts`); UI text via i18n zh+en
  under the §7.1 copy rules; new checks red first.
- Do not start or stop the user's dev stack (ports 3000/8080; it hot-reloads from this worktree);
  keep the app compiling at every commit. No `next build`, no Playwright test runs.
- Before each commit: `pnpm lint`, `pnpm typecheck`, `pnpm check`,
  `pnpm exec vitest run apps/web packages/design tools/checks`. A web changeset per task.

## Tasks (each: one implementer, one review)

### Task 1 — width rule, gutter, settings frame, the client-import check (U1, U7, U8)
- Every template uses the content width (1120, centred, 100% below) with `layout.content-pad`;
  InboxPage, TracePage, OnboardingPage, StatusPage included; head x identical on every page and on
  every tab of one page (`/admin/catalog` tabs). Update spec.md §4.3/§5 (the "full width" exceptions
  go), templates, catalog/reference blocks.
- `/settings/members` uses the SettingsPage frame with the sub-nav; the sub-nav top aligns with the
  content top whatever the head holds (`/settings/tokens`).
- New `check:web-ui` rule `web-ssr-view-value-import`: a server `page.tsx` may import from `./view`
  only its default export and `type` imports. Red fixture first; AGENTS.md CI list.
- Trajectory detail: one edge for stats / waterfall / details, details follow the selected row (or a
  right panel inside the width), no dead gap.

### Task 2 — conversation title bar and the signature path (U2 + Signature)
- Fix the title-bar toggles: each button's accessible name matches the panel it opens; the 「更多」
  menu is not drawn when it would hold ≤ 1 item (generalise: any ⋯/更多 menu with ≤ 1 action is not
  a menu — the action is shown directly or the menu is dropped); remove duplicate entries (catalog
  「浏览市场」 vs 「市场」, agents row 「开始对话」 beside 「对话」, admin account row ⋯ with only an
  explanation).
- Status bar path is always `<login lowercase>@<org slug>:~/<path>` in the workspace and
  `<login>@<slug>:/admin/<path>` in the admin console, on the conversation page too (with the time
  zone); the head path keeps the page path on error and 404 pages; the conversation title-bar path
  uses the head's spacing (「capybara / Grant / …」).

### Task 3 — mobile (U3)
- 390 px: no horizontal overflow anywhere (composer, bubbles, search fields), 16 px side padding;
  tabs `nowrap` + horizontal scroll; tables become stacked rows below 640 (members, accounts, tokens,
  invitations …) via the design DataTable; stat cards 2×2; tap targets ≥ 40 px (row actions, sidebar
  rows, title-bar buttons); mono meta ≥ 11 px. Spec size tables and states updated.

### Task 4 — admin pages (U4, U5, extension detail)
- `/admin/models`: model column min 240, capabilities as text 「工具 · 缓存」, one page ActionRow
  instead of per-purpose 「保存」 (same for org `/settings/models` if it repeats it).
- `/admin/marketplaces` (+ entries): label column nowrap/min width; a raw error becomes one Chinese
  sentence + a collapsible raw text (design component if none exists); the two tabs share one head
  (description, count, search) so the tab bar does not jump; entries' empty state points to
  「市场源」; the official toggle has a label.
- `/admin/extensions/:name`: 「升级」 is a secondary button; info grids use the label/value layout
  (Task 8); bootstrap copy 「由预装步骤从 npm 安装（版本与校验和已固定）。」; list meta 「副本一致 1/1」.

### Task 5 — forms and flows (U6 + forms)
- `/channels/new` without a channel extension renders only the empty state 「先启用一个渠道扩展。」
  with its action — no form.
- Create forms/dialogs: the primary is disabled until valid, no 「没有未保存的修改」 on create
  pages, focus starts on the first field (new org dialog included).
- 「加入评测集」 with no eval set: the dialog links to 新建评测集 (or the page action is disabled with
  the reason).
- Leave-org blocking dialog: button 「知道了」, no red title when nothing destructive is possible;
  destructive dialogs keep red only on the destructive button.
- Install/import flows share card radios and a real 「选择文件」 drop zone (design component).
- `/settings/organization` danger zone in the right column.

### Task 6 — copy sweep (all P2/P3 copy lines)
「新建」 verbs; one name per action/object (重命名, 首页, 管理后台/概览/h1, 创建时间, 未命名会话,
子 agent, personal settings h1 per page); empty-state sentences end with 「。」; 「…」 not 「...」;
full-width 「？」; 「总 token」, 「调用次数」; 「Agent *」 → 「agent *」 where it is running text;
「/」 palette empty → 「这个 agent 没有可调用的技能。」 and a lone 「/」 cannot be sent; home title
→ the page name (no greeting); `/admin/orgs` description one paragraph. Extend `check:i18n` where a
rule is mechanical (e.g. `...` in zh values, half-width `?` after CJK) — red first.

### Task 7 — colour
Selected states use a neutral raised surface + 1 px strong border (radio cards, palette selected row,
trace selected row), orange only on the dot/focus; empty lists show one primary (the empty-state
action becomes secondary, or the head primary hides while empty); 「敏感」 one yellow text mark
everywhere, role 「企业管理员」 plain text, the org extension permission block a hairline; failure in the
status bar red; dark theme: muted ≥ 4.5:1, disabled ≥ 3:1 with a border, card hairlines
rgba(255,255,255,.08), inner scrollbar thumb rgba(255,255,255,.15); login dither greyscale. Tokens +
contrast pairs in `docs/design/tokens.json` (check:tokens enforces floors).

### Task 8 — type, figures and details
Sans for prose (descriptions, dialog bodies, field help, empty-state text), mono only for ids, paths,
numbers, versions; one date format `YYYY-MM-DD HH:mm` (mono) with relative time on hover via one
helper; versions always mono `v…`; label/value grids with a 32 px column gap (home stats, extension
info); ActionRow inside the content container; menus: 8 px collision padding, as wide as the
trigger, the current org in primary text with a check; badges for plain metadata become mono muted
text (visibility, purpose ids); one avatar-tile rule (uppercase initial); 「更多」 flyout items get
icons like the main nav; empty states: one page style and one in-table style.

### Task 9 — the conversation's run row (design first)
A failed or finished run is drawn as an expandable row (`运行 · <model> · <duration> · <status>`):
detail with the error, the trajectory link and, for org/enterprise admins, the fix entry (e.g.
「去配置 openai-compatible」); the properties panel shows the run's model, tokens and cost. Start with a
short design note in spec.md §5.4 and the component flow; then the web wiring.

## Review focus
1. Every page at 1440 and 1920: the head and content left edges identical across all pages and tabs.
2. 390 px: no horizontal scroll on any captured page.
3. Dark theme contrast pairs pass check:tokens.
4. No action shown that the role cannot perform after the menu clean-up (roles-everywhere rule).
5. The copy rules hold in both zh and en.
