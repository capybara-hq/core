# Unslop audit — whole web app (2026-11-03)

Method: the unslop skill's checklist (Damir Sokolovsky, CC BY 4.0, github.com/heydamir/unslop) applied to
149 screenshots of the running acceptance build: every reachable page in light and dark at 1440×900,
dialogs and menus (writes blocked during capture), the command palette, conversation panels and the
composer, and 390×844 mobile. Judged against the approved E 终端 direction and the copy rules in
`docs/design/spec.md` §7.1. Verdict: **light slop** — no classic AI tells (gradients, glows, emoji,
sparkles, uppercase tracking); the problems are system consistency and a few broken states.

Skipped (in progress elsewhere): the extension config form and extension display names
(`docs/superpowers/specs/2026-11-03-extension-config-forms-design.md`).

Priority: P1 broken or confusing, P2 clearly sloppy, P3 polish. Items marked ✔ were verified by hand.

## Already fixed during the audit
- ✔ `/trajectories` failed (500, kernel `limit=NaN`): the server page imported a constant from its
  client view (37f48c6c). Follow-up U1 adds a check so it cannot recur.

## P1
- U1 ✔ A server `page.tsx` must import only the default export or types from `./view` (a value from a
  `"use client"` module is a client reference on the server). Add a `check:web-ui` rule, red first.
- U2 ✔ Conversation title bar: the button named 「文件」 toggles the properties panel (`#properties`)
  and the files panel is unreachable by that name — the two toggles' accessible names / targets are
  swapped or wrong. Also the 「更多」 menu holds only 「文件」, duplicating the icon (drop the menu when
  it has ≤ 1 item).
- U3 Mobile (390): the composer and user bubble overflow to the right (send button cut off); the
  agents list search overflows; the agents tabs 「全部 / 我的 / 组织共享」 wrap one character per line;
  the members table is crushed (names, role, dates truncated); admin overview stat labels truncate.
  Fix: max-width 100% with 16 px side padding, tabs `nowrap` + horizontal scroll, tables become
  stacked rows below 640, stats 2×2. Tap targets ≥ 40 px (row actions, sidebar rows).
- U4 `/admin/models`: model names truncate to 「deepseek/dee」 and capability badges are cut; one
  「保存」 per purpose group (4+ on one screen). Fix: model column min 240, capabilities as text
  「工具 · 缓存」, one ActionRow for the page.
- U5 `/admin/marketplaces`: the 「状态:」 label wraps to two lines; the raw English error is dumped in
  three red mono lines. Fix: label column nowrap/min width; one Chinese sentence + collapsible raw
  text. `/admin/marketplaces/entries` header differs from its sibling tab (no description/count/
  search; tab bar jumps 106→130) and its empty state points to 「市场」 while you are in it (→ 「市场源」).
- U6 `/channels/new` with no channel extension enabled still renders the whole form with an active
  「创建渠道」. Fix: render only the empty state (「先启用一个渠道扩展。」 + action), no form.
- U7 Bounded vs full-width pages look like misalignment, not intent: at 1440 bounded pages start at
  x=288 and full-width ones at 276; `/admin/catalog`'s two tabs differ (288 vs 276), so switching
  tabs shifts the page. Fix: one 32 px gutter everywhere so the head is always at the same x; the
  1120 cap only shows on wider screens; tabs of one page share one template width.
- U8 Settings group: `/settings/members` has no settings sub-nav (all six siblings do) — use the
  SettingsPage frame; the sub-nav jumps down 24 px on pages whose head has a description
  (`/settings/tokens`). Fix: sub-nav top aligned with the content top.

## P2
### Copy
- Verbs: 「新建」 everywhere — 「创建渠道」, 「创建」 (submit), 「创建组织…」, 「谁能建组织」 → 「新建…」.
- Same action, two names: 「重命名」 vs 「改名」; 「返回概览」 vs nav 「首页」; admin 「管理」/「管理后台」/
  「概览」; 「创建于」 vs 「创建时间」; 「未命名对话」 vs 「未命名会话」; 「子代理」 vs 「子 agent」;
  personal settings h1 「个人设置」 on two pages and 「IM 身份」 on the third (use each page's name).
- Empty states are full sentences → end with 「。」 (「还没有渠道连接」, 「还没有评测集」, 「还没有邀请」,
  「还没有服务令牌」, 「还没有绑定任何身份」).
- Ellipses: 「...」 → 「…」 (「删除组织...」, 「更换负责人...」, 「创建组织...」, 「退出组织...」).
- Bootstrap copy is wrong: 「由预装步骤从核心镜像安装」 → 「由预装步骤从 npm 安装（版本与校验和已固定）。」
- Create forms show 「没有未保存的修改」 with an active orange primary; the primary is disabled until
  valid (as new account / token already do), focus goes to the first field (new org dialog focuses
  the button).
- Extension list meta 「一致 (1)  · 9 项权限」 → 「副本一致 1/1 · 9 项权限」.
- The 「/」 palette with no skills shows 「无匹配项」 → 「这个 agent 没有可调用的技能。」; a lone 「/」 can't be sent.
- 「加入评测集」 dialog is a dead end when the agent has no eval set → link to 新建评测集, or disable the
  page action with the reason.
- Leave-org blocking dialog's only button reads 「取消」 → 「知道了」; it is red although nothing
  destructive is possible (red only on the destructive button).
### Colour
- Orange is used as a selected-state fill: radio cards (channel/new, connectors/install, org settings,
  sandbox, admin settings — three on one screen), the command palette's selected row, trace selected
  row. Fix: neutral raised surface + 1 px strong border; orange only on the radio dot / focus.
- Two primaries per screen on empty lists (head button + empty-state button: skills, connectors,
  channels, evals). Fix: the empty-state action is secondary (or the head button hides when empty).
- 「敏感」 has two styles (orange outline in org extensions, yellow fill in admin) → one yellow text
  mark; role 「企业管理员」 is an orange badge → plain text; the org extension permission block is a
  whole orange-bordered box → hairline with a yellow 「敏感」 word.
- `/admin/extensions/:name` 「升级」 is a browser-default blue underlined link → secondary button.
- Dark: muted text, the breadcrumb's first segment, stat labels and disabled controls are ~3:1 →
  muted ≥ 4.5:1 (≈ #8a8a8a), disabled ≥ 3:1 with border; the inner scrollbar thumb is bright white →
  rgba(255,255,255,.15); cards rely on fill only → 1 px rgba(255,255,255,.08) hairline.
### Type and figures
- Mono is used for running text (extension/plugin descriptions, dialog bodies, field help,
  empty-state text) → sans for prose; mono only for ids, paths, numbers, versions.
- Dates in four formats (「11-02 23:42」, 「2026/11/2 23:42」, 「2026年11月1日 21:59」, relative) → tables
  `YYYY-MM-DD HH:mm` mono, relative time on hover; versions → always mono `v0.1.0-rc.0`.
### Layout and spacing
- Page heads at x=276/y=31 on inbox, error, trajectory detail, catalog requests, 404 vs 288/27
  elsewhere (see U7).
- Trajectory detail: three edges (stats 276, waterfall 256, details 272), ~390 px gap with details
  pinned to the bottom, 「本次运行成本（…」 truncated, 「发起人」 shows a UUID, rows say 「运行 运行」.
  Fix: one edge; details right after the selected row (or a right panel); account name with UUID on
  hover; drop the repeated type word.
- ActionRow buttons end at x=1420 while content ends at 1393 → the bar uses the content container.
- Menus touch the viewport edge → 8 px collision padding; menus as wide as their trigger (org
  switcher, account menu); the current org reads as disabled (grey + check) → primary text + check.
- `/settings/organization` danger zone starts at 512 while cards start at 784 → put it in the right
  column.
- Home stat grid: label-to-value 66 px but value-to-next-label 17 px (「1 技能」 reads as one word) →
  two columns label/value, 32 px column gap; same for extension info grids.
- Menus with 0–1 useful item or duplicates: account row ⋯ (only an explanation), catalog ⋯
  (「浏览市场」 = 「市场」), agents row 「开始对话」 next to an 「对话」 button → drop duplicates; no ⋯
  when there is no action.
- Import/install flows look different (cards vs bare radios; the file pick is a tiny 「+」) → card
  radios everywhere and a real 「选择文件」 drop zone; the official marketplace toggle needs a label.
### Signature
- Status bar path: `Grant@Capybara:/chat/…` (org name, no `~`, no UTC+8 on the conversation page) vs
  `Grant@capybara:~/inbox` → always `<login>@<slug>:~/…`, `/admin/…` for admin.
- Head path on errors shows 「~」 → keep the page's path (「capybara / trajectories」).
- Conversation title-bar path 「capybara  /Grant  /」 has asymmetric spacing → same as the page head.

## P3
- Greeting title 「你好，Grant」 on home → the page name or org.
- Placeholder 「想让 Grant 做什么?」 → full-width 「？」; label 「Agent *」 vs 「新建 agent」.
- 「总 TOKEN」 vs 「token」, 「调用数」 vs 「调用次数」 → 「总 token」, 「调用次数」.
- Login side dither has orange pixels → greyscale only.
- Avatar tiles differ (lowercase 「o」, uppercase 「G」, puzzle icon) → one rule (uppercase initial).
- 「更多」 flyout items have no icons while the main nav does.
- `/admin/orgs` two description lines 32 px apart → one paragraph.
- Visibility 「仅自己」 and purpose ids as badges → mono muted text.
- Failure in the status bar is plain grey 「失败」 → red.
- Empty states use three styles → one line-art capybara + text (page) and one compact (in-table).
- Status bar / meta mono looks ~10 px on mobile → ≥ 11 px.

## The conversation's moment
A failed run is one red line 「运行失败：模型供应商认证失败。 · 重试」. The run itself is invisible:
model, duration, 401, which step, no detail, no trajectory link, no fix entry for admins. Draw the run
as an expandable row (`运行 · deepseek-flash · 3.7s · 失败 401`) whose detail shows the error, the
trajectory link and, for admins, 「去配置 openai-compatible」. The properties panel shows only
「上下文 0%」.
