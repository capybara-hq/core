# One responsive system: expanded web to compact

Status: **approved design** (maintainer decisions 2026-11-22, §9; implementation plan `docs/superpowers/plans/2026-11-22-responsive-system.md`). Author: the
compact-list line, 2026-11-22. Supersedes nothing yet; once approved, its §§ 2–6 become changes to
`docs/design/spec.md` (§4, §5, §6.4, §6.6, §6.17, §6.34, §6.56, new components) and to the mobile
layout spec (`2026-11-19-mobile-layout-design.md` §4.5, §5.1).

Companion: `2026-11-22-mobile-interaction-model-design.md` defines the mobile **interaction** model
(navigation layers and back, sheets vs pushed pages, lists, input and keyboard, feedback) that this
layout system serves.

## 0. Why

The maintainer approved a mockup of the 智能体 list at compact width (2026-11-22) and asked first
for it to become the compact rule of the list templates, then (same day) for **one systematic
responsive design from the expanded web down to compact**, not a compact patch: every template
has one described form per size class, pages declare a small typed contract, and the web pages may
change too where a consistent contract needs it.

Today each template has a one-line "Classes" row in the design spec (§5) and the compact forms
grew one decision at a time (head stacking 2026-11-09, chat-first shell 2026-11-21, path row
removal 2026-11-22). The result works but is uneven: list pages put the primary in the head on
compact, cards keep two buttons in each card, the second-level filter is a free `ReactNode`, a
DataTable's stacked form shows every column as label / value, and actions are drawn three ways
(card buttons, ObjectRow action + menu, DataTable row menu).

Approved mockup (the reference for §2), 智能体 at 390:

1. **Head**: no path row; large title with its count in muted mono (「智能体 3」); the primary
   (新建智能体) is a **floating action button** "+" at the bottom end (accent, rounded square ~52,
   above the safe area, named by the action's label); other head actions go into the top row's "…".
2. **Search**: full width under the title, 44 high, filled ground, no border, 16 px text.
3. **Scopes**: the first-level split (智能体 3 / 模板 0, today underline tabs) is a **full-width
   segmented control** with equal parts; the second level (全部 / 我的 / 组织共享, today a small
   Segmented) is a **row of filter chips** (pills; selected = ink fill with page-ground text),
   scrolling sideways; further filters go into the bottom filter sheet.
4. **List**: the card grid becomes a **grouped list of rows** in one rounded card: avatar (rounded
   square), name (500), one muted line (description, else owner · visibility), chevron; rows ≥ 64;
   hairlines inset to the text column; **no buttons in rows**: a tap opens the item; the card's
   actions (开始会话, ⋯ items) move to a **long-press / context-menu action sheet** (bottom sheet,
   44 rows, destructive in fail) and stay reachable on the detail page. (Note 2026-11-22: the
   sheet's rows are `touch.row` 52, the correction in §2.4.)
5. **Scrolled**: when the large title scrolls away, the title appears centred in the top row with a
   hairline under it; search and filters scroll away with the content and come back on scrolling up.

Related lines running now (this doc builds on them, does not duplicate them):
`fix/desktop-compact-title-bar` removes the compact path row for every template (CSS, §4.2) and
gives the desktop shell a flat compact title bar; `fix/compact-control-sizes` makes controls take
mobile sizes under **compact or touch**, with inline padding larger than block padding. Both are
assumed merged below.

## 1. The axes

| Axis | Values | Decided by | Today |
|---|---|---|---|
| Size class | expanded ≥ 841, medium 600–840, compact < 600 | window width (`SIZE_CLASS_QUERIES`) | layout structure |
| Pointer | fine, touch (`TOUCH_QUERY`) | media query | sizes and hit targets (touch tokens) |
| Shell | browser, mobile shell, desktop shell (`data-shell`) | `window.capybaraShell` | top band, insets, drag regions, native nav |
| Frame fit | container queries on the template frame | template frame width | side columns inline vs stacked (§4.3) |

Rules kept: CSS is the authority; pages never branch on class, pointer or shell; the server
renders every variant that differs and CSS shows one (§4 "First paint"). New here: **sizes follow
"compact or touch"** (the `fix/compact-control-sizes` rule) and **structure follows the class**;
the two are independent (a tablet at 1024 with touch gets touch sizes and the expanded structure; a
narrow desktop window gets compact structure and, after that branch, mobile sizes too).

### 1.1 Size rule (from `fix/compact-control-sizes`, restated as the system rule)

| | expanded / medium, fine pointer | compact or touch |
|---|---|---|
| Controls (`control.*`) | 24 / 28 / 32 | mobile sizes (44 / 44 / 52, on touch and at compact whatever the pointer) |
| Padding | as today | inline > block (a 44 control is wider than tall in its padding) |
| Rows (`row.*`) | 32 / 44 / 56 | 44 / 44 / 56; list rows of the grouped list ≥ 64 |
| Hit target | — | 44 × 44 on touch and on compact with a fine pointer (maintainer decision 2026-11-22) |
| Text fields | 13 | ≥ 16 (no iOS zoom) |

Every new part in this doc takes its sizes from these tokens, never literals, so it inherits that
branch.

## 2. The cross-template rules (one model for every page)

These rules are what makes it one system; §3 applies them per template.

### 2.1 Head

| Part | expanded | medium | compact |
|---|---|---|---|
| Path row | shown | shown (way up beside the rail) | **none** (floating back is the way up; `fix/desktop-compact-title-bar`) |
| Title | h1 one line + count / status | same | **large title** (h1 at the compact size), count in muted mono beside it; on a scrolled page it moves into the top row (§2.6) |
| Description | one line, ellipsis | same | wraps |
| Primary action | rightmost head button | same | per template: **FAB** on ListPage; a full-width button under the title on Detail/Overview heads; the sticky ActionRow on Form/Wizard/Settings sections (unchanged) |
| Secondary actions | head buttons + `more-horizontal` | same | **the floating row's "…" overflow** on every pushed page (one place for "more" on compact), never a second row of buttons in the head |
| Tabs (first-level scope) | underline tab row with counts, search at its end | same | **full-width segmented control** for 2–3 scopes; 4+ stay a sideways-scrolling tab row |

### 2.2 Scopes and filters (three levels, one model)

| Level | Declared as | expanded / medium | compact |
|---|---|---|---|
| 1. Scope (what set) | `header.tabs` (exists) | underline tabs | segmented (2–3) / scrolling tabs (4+) |
| 2. View (subset of the set) | **new `ListPage.scope`** (typed, replaces the free `filters` node for view choices) | `Segmented` (≤ 5) or a secondary `Tabs` row | **filter chips** row, sideways scrolling |
| 3. Field filters (by attribute) | `ListPage.filters` (kept: `Field` + `Select`), facet `rail` | inline toolbar / facet rail while it fits, else Filter sheet | **Filter button + bottom sheet** holding both the field filters and the rail; the button shows the count of active filters |

Today the level-2 choices are passed as arbitrary nodes (a `Segmented` on /agents, a `Tabs` for the
admin template owner filter and the marketplace sources); the template cannot know they are a view
choice. A typed `scope` lets it draw chips without guessing.

### 2.3 Content forms

| Content | expanded | medium | compact |
|---|---|---|---|
| Card grid (`CardGrid`) | auto-fill columns ≥ 280 | 2 columns once they fit, else 1 | **grouped list of rows** in one rounded card (§0 item 4) |
| `ObjectList` / `ObjectRow` | panel of rows, action + menu at the right | same | grouped rows; **no buttons when the row opens something** (actions → action sheet); a row that opens nothing keeps its one action button (the marketplace's 安装) |
| `DataTable` | table | table (horizontal scroll inside its frame) | **grouped rows by the declared row mapping** (§4.3); without one, today's stacked label / value rows (fallback) |
| Side column (rail, label column, sub-nav, inbox list, right area) | inline while it fits | stacked / sheet | bottom sheet, stacked or **pushed page** (unchanged rules, §4.3) |
| StatCards | row of ≤ 5 | row of ≤ 4 | 2 × 2 |

### 2.4 Actions model

One menu model for every object, drawn per class:

```ts
type ObjectActions = {
  /** The object's main action (开始会话, 用它创建, 查看). */
  primary?: HeaderButtonLike;
  /** The rest, in order; `danger` marks destructive items. */
  items?: MenuItem[];
};
```

- **expanded / medium**: as today: a card's primary button + ⋯; an ObjectRow's action + ⋯; a
  DataTable's row menu.
- **compact**: the object's row shows no buttons; long press (500 ms, < 10 px movement) or a
  context-menu event (right click, two-finger tap, Android long press) opens the **ActionSheet**
  (new design overlay: bottom sheet titled with the object's name, `touch.hit` rows (corrected
  2026-11-22, coordinator ruling: the rows follow the sheet standard's `touch.row` 52, §6.59 of
  the design spec, #591; the 44 hit target holds), `danger` in fail, links navigate, a pick
  closes then runs, system back closes it). In a native shell with `menu@1` a sheet of plain
  actions may use the platform sheet.
- Every action stays reachable on the object's detail page (a page requirement, §4.4).
- Discoverability: nothing hints at the long press; that is accepted, since every action is also on
  the detail page (decision D3).

`ObjectCard` (`primary` + `menu`), `ObjectRow` (`action` + `menu`) and `DataTable` (`rowMenu`)
already carry this data; the change is the type name and the compact drawing, so cards and object
rows need **no page change**.

### 2.5 Floating controls on compact

- Lead: menu (chat surface) or back (pushed page): unchanged.
- Centre: the conversation's title pill (unchanged) or, on a scrolled pushed page, the page title
  (§2.6).
- Trailing "…": the page's overflow = the page's registered menu + the head's secondary actions
  (`ShellPage.actions`, new; links navigate through the shell's `onNavigate`).
- Bottom end: the **FAB** (ListPage's primary only): `touch.prominent` square, radius `md`,
  `accent` with a 24 `plus` (or the action's icon), `shadow-float-touch`, `space.4` from the end
  edge and above `--cb-inset-bottom` (covers native nav chrome); the list leaves room at its end.

### 2.6 Scrolling on compact

- A pushed page scrolls as **one** scroller, head included (today the head is fixed and the body
  scrolls: on a phone that keeps ~180 px of head on screen forever).
- When the large title passes under the floating row, the page reports `titleAway` and the row
  draws the title centred with a `line-soft` hairline under its strip.
- Search and scopes (§2.2 levels 1–2) scroll away with the content; scrolling up brings them back
  under the row (quick return, `motion.overlay`, none under reduced motion); scrolling down hides
  them again. They are one block, a direct child of the scroller, so `position: sticky` works.
- Exceptions: the conversation (its own thread scroller), the settings sub-nav (stays sticky,
  decision 2026-11-09), sticky ActionRows (stay).

## 3. Per template

Each table is what the page **is** at each class. "Same" means the expanded form; sizes always
follow §1.1. ★ marks a change from today.

### 3.1 ListPage (T2)

| | expanded | medium | compact |
|---|---|---|---|
| Head | path, title + count, description, secondary + primary at the right | same | ★ no path, large title + count (count = `header.count`, else the first tab's count), primary → ★ FAB, secondary → ★ "…" |
| Tabs | underline + search at the row end | same | search ★ full width 44 filled; tabs ★ segmented (2–3) |
| Level 2 | `scope` as Segmented / secondary Tabs | same | ★ chips |
| Field filters / rail | inline while it fits | Filter side sheet | Filter bottom sheet ★ (field filters join it) |
| `cards` | grid | 2 / 1 columns | ★ grouped rows + action sheet |
| `objects` | ObjectList panel | same | ★ grouped rows; buttons only when the row opens nothing |
| `records` | DataTable | same | ★ row mapping rows (§4.3), fallback stacked |
| StatCards | ≤ 5 | ≤ 4 | 2 × 2 |
| Scroll | body scrolls | same | ★ one scroller, quick-return bar, scrolled title |
| Empty | page EmptyState carries the primary | same | same (no FAB then: one primary per screen) |

### 3.2 DetailPage (T3)

| | expanded | medium | compact |
|---|---|---|---|
| Head | path, (avatar) title, status, actions | same | ★ no path; title large; primary ★ full-width button under the title; secondary ★ "…" |
| Band head (device) | path + actions row, name band | same | ★ no path row; band stacks (today) |
| Facts | facts block first | same | same, label above value |
| PageTabs | head's tab row | same | ★ segmented for 2–3, scrolling row for 4+ |
| Body tables | DataTable | same | ★ row mapping |
| Scroll | body | same | ★ one scroller + scrolled title |

### 3.3 SettingsPage (T5; the agent page, account and org settings)

| | expanded | medium | compact |
|---|---|---|---|
| Head | path, avatar, title, actions | same | ★ no path; primary (开始会话 on the agent page) full width under the title; secondary ★ "…" |
| Sub-nav | 200 column beside content while it fits | stacked above | sticky sideways row (kept) |
| Section tabs (`header.tabs`, 模型 / 用途默认) | open the content column | same | ★ segmented |
| Sections | FormSection: label column while it fits | labels above | labels above; each section's ActionRow sticky (kept) |
| Tables in sections | DataTable | same | ★ row mapping |
| Scroll | content column | same | one scroller under the sticky sub-nav (today's behaviour) + ★ scrolled title |

### 3.4 FormPage (T4) and WizardPage (T9)

| | expanded | medium | compact |
|---|---|---|---|
| Head | path, title | same | ★ no path; title large |
| Fields | 240 label column while it fits | labels above | labels above, ★ mobile field sizes (§1.1) |
| Submit | ActionRow | same | sticky ActionRow, primary full width (kept) |
| Wizard steps | step bar | same | "2 / 4" text (kept) |

No new declarations.

### 3.5 OverviewPage (T1), StatusPage (T11), OnboardingPage (T12)

Overview: StatCards 5 / 4 / 2 × 2, sections stacked on compact (kept); head as §2.1 (★ no path,
primary full width, secondary "…"). Status / onboarding: centred card, full width with 16 gutters
on compact (kept); their actions become full-width stacked buttons on compact ★ (today they sit
side by side and wrap).

### 3.6 InboxPage (T6)

List + item (facts inline) / ListDetail two panes when they fit / two-level stack on compact with
the sticky decision row (all kept). ★ The list rows follow §2.3's grouped-row look on compact; the
rows have no long press: decisions are deliberate and made on the pushed item (decision D6).

### 3.7 TracePage (T8)

Waterfall + detail (1280: side panel) / detail below / waterfall full width with a span pushed
(kept). ★ No path on compact; stats 2 × 2.

### 3.8 ConversationPage (T7), SetupPage (T13), AuthPage (T10), SharedFilePage (T14)

Unchanged structure (chat-first shell, setup steps pushed, centred auth card, shared file bar);
they only take §1.1 sizes. The conversation's own compact rules (title pill, right area pushed)
are the model the list pages now follow for their top row.

## 4. The page contract (typed props, defaults so most pages declare nothing)

| Declaration | Where | Default (no declaration) | Who must declare |
|---|---|---|---|
| Primary action | `header.actions` item with `variant: "primary"` (exists) | none → no FAB / no full-width button | already declared by every page that has one |
| Secondary actions | `header.actions` (exists) | → "…" on compact | nothing |
| First-level scope | `header.tabs` (exists) | segmented / tabs by count | nothing |
| **View choice (level 2)** | **new `ListPage.scope: { label, value, options: {value,label,count?}[], onChange }`** | none | pages that pass a `Segmented`/`Tabs` in `filters` today: /agents, admin agent and connector templates, the marketplace (4) |
| Field filters | `ListPage.filters` (kept, now only fields) | → Filter sheet on compact | nothing |
| **Row mapping** | **new `Column.compact?: "title" \| "subtitle" \| "meta" \| "trailing" \| "hidden"`** on DataTable columns; `DataTable.compactLead?(row)` for an avatar/mark | stacked label / value rows (today) | every DataTable that should look like a list on phones (§5) |
| Object actions | `ObjectCard.primary/menu`, `ObjectRow.action/menu`, `DataTable.rowMenu` (exist) | → action sheet on compact | nothing for cards and object rows; tables with actions only in cells (a switch) must also offer them in `rowMenu` |
| Opens a detail | `href` / `onOpen` (exist) | a row without one keeps its action button | nothing |

### 4.1 Web changes the system asks for (the maintainer allows them)

1. **`filters` split**: view choices move to `scope` (4 pages); `filters` keeps field filters.
2. **Table row mapping** on the member pages' tables first (§6).
3. **Every action reachable on the detail page**: audit the cards whose ⋯ holds something the
   detail lacks (agent card 另存为模板 is on the agent page: yes; template card switch actions: on
   the template page: yes; connector cards: check).
4. **Head counts**: list pages that show a total pass `header.count` (or rely on the first tab's).
5. **Status/empty actions**: nothing.

No page writes styles and no page learns about size classes; every change above is data.

### 4.2 Row mapping detail

- `title`: one line, 500, `ink` (exactly one column; default the first column).
- `subtitle`: one muted line (the first `subtitle` column; more are joined with 「 · 」).
- `meta`: a faint `small` line (optional, joined with 「 · 」).
- `trailing`: the right end before the chevron: a state label, a count, a time (at most one).
- `hidden`: not drawn on compact (bulk checkboxes, wide numbers that the detail shows).
- Row height ≥ 64 with a lead (avatar or mark), ≥ 52 without; chevron when the row opens.
  (Note 2026-11-22, coordinator ruling: a row with a lead is exactly 64 with up to two text lines;
  a third line grows it by 20.)
- Interactive cells (`interactive: true`, a switch) render in the trailing slot only when declared
  `trailing`; otherwise the action must be in `rowMenu`.
- Selection and bulk actions: hidden on compact (decision D5); bulk work is desktop work.

## 5. Same DOM or two DOMs

### 5.1 Rule

**Default: one DOM restyled** by media queries (class structure) and container queries (frame
fit). A template or component may render a **different structure per class only when one of these
holds**:

1. **Semantics differ**: the accessible structure must change (a `table` vs a list of links; tabs
   vs radio-like segments are *not* such a case: `Tabs` restyles as a segmented control keeping
   `role="tablist"`).
2. **Interaction differs**: elements exist in one form and must not in the other (row buttons vs
   an action sheet; the facet rail inline vs inside a sheet that owns focus).
3. **Placement crosses a landmark or a scroller** that CSS cannot cross: a control must sit in the
   shell's top row (secondary actions → "…"), or in a different scroll container (the quick-return
   bar).

Not reasons: different sizes, order, wrapping, visibility of decoration, a button becoming fixed
(the FAB is the head's primary restyled `position: fixed` where possible — see §5.3).

### 5.2 Mechanisms compared (the server does not know the width)

| Mechanism | First paint | Hydration | a11y / ids / focus | Resize / fold | Verdict |
|---|---|---|---|---|---|
| A. CSS-switched dual render: server renders both, `display: none` hides one; after hydration only the matching one stays mounted (`useHydrated` + `useSizeClass`, today's `data-responsive` / `data-fold` pattern) | right, no flash | prune after hydration (one commit) | hidden copy is out of the a11y tree; ids must come from `useId` (unique per copy); focus targets exist once visibly | live (CSS before JS, then remount) | **chosen for two-DOM cases** |
| B. Container queries only | right | none | one copy | live | **chosen default** (same DOM) |
| C. Size-class cookie / `Sec-CH-Viewport-Width` client hint, server renders one form | right only if the guess holds; wrong after a resize, a fold, a split view, a first visit (cookie empty), Safari/Firefox (no client hints) | mismatch = hydration error or flash | one copy | needs a re-render | rejected as the mechanism; allowed later only as an optimisation that skips the hidden copy when the hint is certain |
| D. Render after hydration only (nothing on the server) | flash / layout shift; no SSR content | — | one copy | live | rejected (breaks the no-flash and SSR-loading rules) |

### 5.3 How A is done uniformly

- One design helper, `ClassForms({ compact, wide })` (name open), that renders both with
  `data-class-form="compact|wide"` before hydration and only the matching one after, plus a
  `useClassForm()` hook for templates. No component writes its own `useHydrated` + `useMediaQuery`
  pair again; `pnpm check` forbids the pattern outside the helper (§7).
- Both copies may hold the same React state source (props), never their own competing state: a
  search value lives in the page; a sheet's open state in the template.
- Inputs in the hidden copy are `display: none` (not focusable, not in the a11y tree); the helper
  sets `inert` on the hidden copy until the prune, so a fast tab key cannot reach it.
- Tests: `renderAtClass(width, ui)` (jsdom: stubs `matchMedia`, renders, flushes hydration) and
  assertions that each accessible name of a landmark/control occurs once.

### 5.4 Where two DOMs are expected

| Component / template | Case | Mechanism |
|---|---|---|
| `ObjectCard`, `ObjectRow` | buttons (wide) vs none + long press (compact) | A (buttons pruned on compact) |
| `DataTable` | table vs mapped rows | A (exists today for stacked rows) |
| `PageHeader` | path + actions row (wide) vs none, actions → shell "…" (compact) | A + shell registration |
| `ListPage` compact bar | search + scopes in the head's tab row (wide) vs the quick-return block in the scroller (compact) | A |
| FAB | head primary restyled `position: fixed` (same DOM) if the head is inside the scroller; else A | B preferred |
| `Tabs` → segmented | same DOM, `look` attribute | B |
| `Segmented` / scope → chips | same DOM | B |
| Body facet rail / sheet | exists (A) | A |
| Sidebar / drawer, right area / pushed page | exist | A |

## 6. Inventory

89 route pages under `apps/web/src/app` (80 `(app)`, 8 `(auth)`, 1 `/dev/ui`). By template (one
route counted once; components that draw templates — `ErrorFrame`, `NoAccess`, `KernelStarting`,
`AppFrame`'s setup home, `ScheduleCalendarView`, `AgentPage`, the agent and template frames — are
counted with the routes that use them): ListPage 26, SettingsPage 18, DetailPage 17, FormPage 6,
WizardPage 5, OverviewPage 3 (+ setup home), TracePage 2, InboxPage 2, StatusPage 2 (+ 3
components), ConversationPage 2 (`/`, `/chat/<id>`), AuthPage 7, SharedFilePage 1, redirect 1.

Audience: **M** member-facing and shown on touch; **O** org admin (desktop-only on touch: plugins,
extensions, channels, settings, evals, trajectories; mobile layout spec §4.6), so compact reaches
them only in a narrow desktop window; **S** super admin (`/admin/**`, desktop-only on touch).
Declarations: **auto** = follows from the template; **scope** = migrate a level-2 view choice to
`ListPage.scope`; **rows** = DataTable row mapping; **detail** = make sure the row's actions are on
the detail page.

### 6.1 ListPage (26)

| Route | Aud. | Variant | Scopes | Primary → | Needs |
|---|---|---|---|---|---|
| `/agents` | M | cards | 智能体 / 模板 → segmented; 全部 / 我的 / 组织共享 → chips | 新建智能体 → FAB | **scope** |
| `/connectors` | M | cards | 全部 / 已停用 (when any) → segmented | 安装连接器 → FAB; 我的连接 → "…" | auto (**detail** check) |
| `/conversations` | M | objects | — | 新会话 → FAB | auto |
| `/devices` | M | cards | — | 新建设备 → FAB | auto |
| `/schedules` | M | records + calendar | 日历 / 列表 → segmented | 新建定时任务 → FAB | **rows** |
| `/skills` | M | objects | plugin `Select` → Filter sheet | 上传技能 (admin) → FAB | auto |
| `/channels` | O | cards | tabs → segmented | 接入渠道 → FAB | auto |
| `/plugins` | O | objects | 3 tabs → segmented | → FAB | auto |
| `/extensions` | O | records | 7 tabs → scrolling tabs | — | **rows** |
| `/evals` | O | objects | 评测集 / 运行 → segmented | → FAB | auto |
| `/trajectories` | O | records | same tabs; agent + status filters → sheet | — | **rows** |
| `/admin/accounts` | S | records | — | → FAB | rows (optional) |
| `/admin/agents` | S | records | 智能体 / 模板 (links) → segmented; org `Select` → sheet | — | rows (optional) |
| `/admin/agents/templates` | S | cards | owner Tabs → chips | — | **scope** |
| `/admin/audit` | S | records | — | — | rows (optional) |
| `/admin/connectors` | S | records | org + status selects → sheet | — | rows (optional) |
| `/admin/connectors/templates` | S | records | owner Tabs → chips | — | **scope**, rows (optional) |
| `/admin/extensions` | S | records | 7 tabs → scrolling | — | rows (optional) |
| `/admin/models` | S | records | 模型 / 用途默认 → segmented | — | rows (optional) |
| `/admin/orgs` | S | records | — | 新建组织 → FAB | rows (optional) |
| `/admin/plugins` | S | objects | 3 tabs → segmented | → FAB | auto |
| `/admin/plugins/market` | S | objects | sources Tabs → chips | — | **scope** |
| `/admin/plugins/pending` | S | objects | tabs | — | auto |
| `/admin/plugins/sources` | S | records | tabs | 添加来源 → FAB | rows (optional) |
| `/admin/skills` | S | records | 技能 / 模板-like tabs → segmented | — | rows (optional) |
| `/admin/themes` | S | records | tabs → segmented | — | rows (optional) |

### 6.2 SettingsPage (18)

| Route | Aud. | Needs |
|---|---|---|
| `/agents/<id>` (the agent page) | M | auto (开始会话 full width; ⋯ → "…") |
| `/agents/templates/<id>` | M | auto |
| `/account/profile`, `/preferences`, `/connections`, `/shares` | M | auto |
| `/account/grants`, `/identities`, `/notifications` | M | **rows** (one table each) |
| `/settings/organization`, `/appearance`, `/sandbox`, `/shares` | O | auto |
| `/settings/models` | O | auto (tabs → segmented) |
| `/settings/members`, `/tokens`, `/schedules`, `/audit` | O | **rows** |

### 6.3 DetailPage (17)

| Route | Aud. | Needs |
|---|---|---|
| `/connectors/<id>`, `/devices/<id>` (band head), `/skills/<id>`, `/p/<plugin>/<id>` | M | auto; `/skills/<id>` **rows** (2 tables) |
| `/channels/<id>`, `/plugins/<item>`, `/evals/<set>`, `/evals/runs/<run>` | O | auto; evals **rows** |
| `/admin/agents/<id>`, `/admin/agents/templates/<id>`, `/admin/connectors/<id>`, `/admin/connectors/templates/<id>`, `/admin/extensions/<name>`, `/admin/p/<plugin>/<id>`, `/admin/plugins/<item>`, `/admin/skills/<id>`, `/admin/themes/<id>` | S | auto; tables rows (optional) |

### 6.4 The rest (28)

| Template | Routes | Aud. | Needs |
|---|---|---|---|
| FormPage (6) | `/agents/new`, `/schedules/new`, `/schedules/<id>` (has a run table: **rows**) | M | auto |
| | `/channels/new`, `/evals/new` | O | auto |
| | `/admin/settings` | S | auto |
| WizardPage (5) | `/connectors/install` | M | auto |
| | `/plugins/<item>/connectors`, `/plugins/<item>/enable`, `/evals/<set>/run` | O | auto |
| | `/admin/plugins/import` | S | auto |
| OverviewPage (3 + setup) | `/admin` | S | auto |
| | template-off state of `/agents/templates/<id>`, connection state of `/channels/new`, the setup home | M / O | auto |
| InboxPage (2) | `/inbox` | M | auto |
| | `/admin/inbox` | S | auto |
| TracePage (2) | `/trajectories/<id>`, `/evals/<set>/cases/<case>` | O | auto |
| StatusPage (2 + 3) | not found, `/s/<code>` states, ErrorFrame, NoAccess, KernelStarting | all | auto |
| ConversationPage (2) | `/`, `/chat/<id>` | M | auto (unchanged) |
| AuthPage (7) | login, setup, change-password, invite, bind, devices/link, apps/authorize | all | auto (sizes only) |
| SharedFilePage (1) | `/s/<code>` | public | auto |

### 6.5 Counts

| | M | O | S | total |
|---|---|---|---|---|
| Templated routes (excl. auth, shared file, not found, redirect, dev) | 24 | 25 | 28 | 77 |
| auto (no declaration) | 17 | 17 | 13 | 47 |
| needs **scope** | 1 | 0 | 3 | 4 |
| needs **rows** (required for M / O; optional for S) | 6 | 8 | 13 | 27 |

(`/admin/connectors/templates` needs both, so the S row adds up to 28 with one overlap.)

\* Re-derived with `pnpm --filter @capybara-hq/checks inventory:templates` (2026-11-22): the O and S
counts and every per-template count of §6 held; the member count was 24, not 26, because the first
count added the template-off state of `/agents/templates/<id>` and the setup home, which are no
routes of their own (they are states of routes already counted). Overview states inside other
routes and the shared components are counted with their routes.

## 7. Guards

| Guard | What | Where |
|---|---|---|
| `web-ui-size-branch` (new rule of `check:web-ui`) | apps/web pages and components may not import `useSizeClass`, `useMediaQuery`, `useTouch`, `SIZE_CLASS_QUERIES` or read `window.innerWidth` / `matchMedia` (today only `AppFrame` and extension hosts do; they get a reasoned allowlist) | full, cheap |
| `design-dual-render` (new design check) | a component may not pair `useHydrated` with a class/touch query outside the `ClassForms` helper | full, cheap |
| `design-breakpoint` (exists) | unchanged: only 599 / 600 / 840 / 841 / 1280 in width media queries | — |
| `web-ui-filters-scope` (new) | `ListPage.filters` may not contain a `Segmented` or `Tabs` (use `scope`) | full |
| jsdom: one copy | `renderAtClass` tests per template at 390 / 768 / 1440: no duplicate accessible names after hydration, compact = no path, FAB present, segmented, chips, rows without buttons, action sheet on long press / contextmenu | by diff |
| Touch hit size | Playwright at 390 with touch emulation: every interactive part ≥ 44 × 44 (box or `::after` ring); at 390 / 480 fine pointer ≥ 44 too (maintainer decision 2026-11-22; `compact.interaction.spec.ts`, `mobile-sizes.ts`) | visual job |
| Visual baselines | per template one page at 390 (touch), 768, 1440, light and dark (`visual-update` only) | visual job |
| Size tables | `narrow` states of `card-grid`, `object-list`, `data-table`, `page-header`, new `action-sheet` and `list-fab` re-measured | fidelity |

## 8. Phasing

1. **Phase 0 — system pieces (design package only)**: the spec text of §§ 2–5, `ClassForms`,
   `ActionSheet`, `ListFab`, `Tabs look="segmented"`, scope chips, CardGrid / ObjectRow compact
   rows, one-scroller pushed pages with scrolled title and quick return, `ShellPage.actions`,
   guards. Every page that needs no declaration (49 routes) follows here.
2. **Phase 1 — member pages people use on phones**: `scope` on /agents; row mapping on
   /schedules, /account/grants, /identities, /notifications, /skills/<id>, /schedules/<id>;
   action reachability audit (connectors, devices). Visual baselines for agents, skills,
   connectors, schedules, conversations, inbox, account.
3. **Phase 2 — org admin pages**: they are desktop-only on touch, so compact means a narrow desktop
   window; row mapping on their 8 pages with tables. Done because a narrow desktop window is common
   (split screen) and the declarations are small.
4. **Phase 3 — super admin**: **automatic forms and sizing only, no row mappings**: tables keep
   the stacked fallback, the 3 `scope` migrations done because the `filters` guard requires them.
   Decided (D8): desktop-only on touch, used by one or two people, rarely in a narrow window; the
   fallback is readable; every declaration is maintenance.

Each phase is one PR (phase 0 possibly two: overlays + templates), reviewed with screenshots at
390 / 768 / 1440.

## 9. Decisions (maintainer 2026-11-22)

All ten open questions of the review draft were answered as the draft proposed:

- **D1** Secondary actions on compact always go into the top row's "…", also when there is only
  one (today's "one secondary stays a button" rule ends on compact).
- **D2** The primary on non-list pages at compact is a full-width button under the title (no FAB,
  no text button in the top row); the FAB is the ListPage's only.
- **D3** Long press is accepted as invisible: no hint and no trailing ⋯ on rows; every row action
  is also on the object's detail page.
- **D4** Four or more first-level tabs stay the sideways-scrolling tab row; two or three are the
  segmented control.
- **D5** DataTable selection and bulk actions are hidden on compact.
- **D6** Inbox rows have no long press; decisions are made on the pushed item.
- **D7** Every pushed page scrolls as one scroller on compact (List, Detail, Settings, Overview,
  Trace, Form, Wizard), with the scrolled title in the top row; the conversation keeps its thread
  scroller, sticky sub-navs and ActionRows stay sticky.
- **D8** Super admin pages get the automatic forms and sizing only (no row mappings; the three
  `scope` migrations still happen because the guard requires them).
- **D9** Medium (600–840) keeps the expanded head and actions, touch or not; only sizes follow
  touch there.
- **D10** The count beside the large title is the first head tab's count by default; `header.count`
  overrides it.

## 10. Rejected alternatives

- **A compact-only patch of `ListPage`** (the first brief): leaves Detail / Settings / tables
  inconsistent; replaced by this doc at the maintainer's request.
- **Server-side class from a cookie or client hint**: wrong on resize, fold, split view and the
  first visit; hydration mismatches (§5.2 C).
- **Segmented control becoming chips everywhere**: the rule belongs to the list template's
  level-2 scope, not to every Segmented (forms keep theirs).
- **Pages passing compact-only props** (`compactTitle`, `fabAction`): pages would start to know the
  class; the contract (§4) is class-free.

## AGENTS.md rules touched

- **Web UI**: pages stay template + design components and write no styles; new behaviour lives in
  `packages/design`; pages only declare data (`scope`, column `compact` roles). The new guards
  extend `check:web-ui`. AGENTS.md change, made with phase 0: one line "pages never read the
  size class (`web-ui-size-branch`); a structure that differs per class goes through `ClassForms`".
- **Mobile and shells**: layout follows size classes by window width, adapted in templates and the
  shell, never in pages (`design-breakpoint`, unchanged); sizes follow "compact or touch" (the
  `fix/compact-control-sizes` rule). Native shells still detected only through
  `window.capybaraShell`. No other change.
- **Language**: new UI labels (action sheet title fallback, FAB tooltip) go through zh and en
  (`check:i18n`); zh never 企业 or the Latin word for agent. No change.
- **When a rule can be checked automatically, the check is the authority**: each new guard in §7
  ships with a red fixture first. No change.
