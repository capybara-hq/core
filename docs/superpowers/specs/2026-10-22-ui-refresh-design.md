# UI Refresh: Refined E, Left-Sidebar Shell and Conversation Page — Design

- First draft: 2026-10-22 (Chinese, written against the M5-era `main`, fc3b558).
- This revision: 2026-10-24, rewritten in English against the post-M7 `main` (5bb285b) for maintainer review.
- When: **after M7**; M7 has shipped, so this is now up for scheduling.
- Design canvas: https://claude.ai/artifact/USm2Mfhi3PqqgmkW4USLbz (rows listed in §9). Early layout wireframes were kept locally under `.superpowers/brainstorm/7142-1792663469/content/`, not checked in; the canvas wins.

**Markers**
- **(decided)**: the maintainer said so in the 2026-10-22 discussion, or accepted a designer proposal afterwards. Binding.
- **(designer's call)**: the author decided on the maintainer's behalf; not yet confirmed item by item. Open to change in review.
- Items with no marker restate current code or rules from `AGENTS.md`, `docs/design/spec.md` and the skills.

**Terminology.** The UI refresh is **not coupled** to the package ecosystem spec (`docs/superpowers/specs/2026-10-22-package-ecosystem-design.md`, branch `docs/package-ecosystem`) and does not wait for its rename or repository split (decided, 2026-10-24). UI copy uses whatever names the code has when each project is built, and follows the rename when it lands. This document uses the ecosystem spec's concepts where it needs a word for them: the in-process code of a package is an **extension** (today's code calls it a plugin), a versioned contract is an **extension point** (today: capability), and an iframe UI is an **embed page** (today: embedded app). "Conversation" always means talking to an agent. Where this document names code, it uses the code's current names (`ctx.ui`, `plugins/*`, `/admin/plugins`, `/directory`).

**Two things that must not be confused** (decided, 2026-10-24):
- **File outputs**: files the agent generates in the sandbox and delivers (code, PDF, Word, spreadsheets, images…; today `sandbox_deliver` → `artifact_created`). Built into the conversation page (§5.4, §5.8). How a file is previewed is an **extension point**: the web app ships a small default set of previewers and extensions can contribute more.
- **Artifacts**: online, collaborative documents, spreadsheets and designs, created and edited in place and shared. Project C, separate and later (§6). The kernel's current identifiers for delivered files (`artifact_created`, `/artifacts/:id/…`) are historical names for *file outputs*; UI copy calls those "files", never "artifacts".

**Supersedes** §3.1 (layout), §3.2 (the kernel's built-in tabs) and §3.3 (tool call display) of `2026-10-21-chat-panel-plugin-ui-design.md` (D13). The rest of D13 stays in force: `ctx.ui`, rendered views, embed pages, embed tokens, the `/plugin-ui` proxy, permissions. This document only adds places where extension UI can appear.

---

## What changed since the 2026-10-22 draft

- **Rebased on post-M7 code.** M6 added the trajectory viewer (`/trajectories`, TracePage + `SpanWaterfall`, design spec §6.10), evals (`/evals/*`), the admin console (`/admin/*`: accounts, orgs, plugins, catalog, models, deployment settings), the org catalog (`/directory`), members, model purposes and installed apps under `/settings/*`. M7 added hook denials in the conversation (`hook_denied`, a failed run names the blocking extension), the channel inbound-mode switch, same-origin attachment upload through the web's object-store proxy, and the release pipeline. The shell, the 12 templates and the conversation timeline components are unchanged since the draft; §4 and §5 now name what each part replaces.
- **Inventory of what the shell must carry** (§4.4): the TopBar today has 9 top-level items plus an "Extensions" menu; org settings hang off the "Connectors" item; the admin console has its own second-level nav. The sidebar now has to hold all of these, so it gets an explicit section layout.
- **There is no conversation list in the web app today.** Conversations start from the Agents list, which creates the conversation before the first message; the kernel's `GET /conversations` is a flat "mine" list; conversation `title` exists in the schema but nothing sets it and nothing can rename it. The sidebar's conversation section (§4.4) and the title bar (§5.1) need titles and a grouped list API (§5.9).
- **Model and effort switching is grounded in the actual model contract.** `effort` is a standard knob that each model declares (subset of `low|medium|high|xhigh|max`) or doesn't; agents have `model` + `fallback` + params; `model_call` already records the resolved model and params per request. The maintainer decided the switchable range: any chat model from the org's enabled providers (§5.2).
- **File outputs are built in; Artifacts stay project C.** The draft wanted a small plugin to show delivered files and blurred them with Artifacts. Now: file outputs (section, cards, preview panel) are built into the conversation page, file previewing is an extension point (`file-preview@1`, §5.8), and Artifacts are online collaborative documents (§6). The todo extension and `example-board` validate the extension slots (§5.4).
- **MCP Apps is its own stage B2**, right after B, because it needs plumbing the other slots don't: `connector-mcp` drops `_meta` (except one Anthropic hint) and the MCP `title`; `ToolSpec` has no title; `EmbedFrame` only takes a `src`; `/plugin-ui` only serves extension routes (§5.3).
- **Conversation titles are model-generated** after the first exchange, with manual rename (§5.1, §5.9).
- **Sizing is a scale, not one number.** The draft's "28 only" vs "28 default, 24 in tables" ambiguity is replaced by named scale steps with usage rules (§4.3).
- **The maintainer's answers of 2026-10-24** to the first round of open questions are recorded in place, marked (decided, 2026-10-24).
- **Subagents now have a direction.** The ecosystem spec §11 plans subagents as a built-in tool whose child run has its own event log (a child conversation). §5.6 uses that shape; the UI still ships with fixture data until the runtime exists.
- **Approvals offer three scopes** (`once` / `session` / `always`, filtered by what the request allows), not two; §5.7 follows the code.
- **Release mechanics.** UI changes now ship through changesets: `@capybara-hq/design` is private and ships only inside the web image, so every UI change needs a changeset on `@capybara-hq/web` (fixed group with `@capybara-hq/capybara`, so it bumps the image tag). Kernel and SDK changes need their own changesets, and SDK changes regenerate `api/plugin-sdk.api.md` (§8).
- **Independent of the package ecosystem work.** No dependency on its rename or on the move of official plugins (todo, `connector-mcp`, `example-board`) to `capybara-hq/plugins`; the shared seams are coordination points (§3, §8). UI copy uses the code's names at build time.
- **Language.** The spec is now in English, per `AGENTS.md`.

---

## 1. Why

- After using the Claude Code desktop client, the maintainer finds it more refined than Capybara's web app and wants to learn from it (decided):
  - the overall structure: left sidebar, conversation in the middle, panel on the right;
  - how tools, subagents and files are shown in the conversation;
  - "click something in the conversation, its detail opens on the right".
- Three pixel styles were tried (pixel outline, full dot matrix, retro desktop). After comparing them the maintainer **kept E (Terminal)**; the original choice of E was sound (decided).
- The problem with E is not its direction but that it is not refined enough (decided):
  - too many lines;
  - too many spots of color;
  - characters standing in for icons;
  - padding in controls and cards is too large;
  - long Chinese prose in a monospace font reads stiffly;
  - no motion.
- Extensions need to add UI to the conversation page: "the right-hand area can be provided by plugins". An extension that is not enabled shows no icon and no panel (decided).

## 2. Goals, non-goals, anti-goals

**Goals**
1. Replace the global TopBar with a left sidebar on every page (decided).
2. Refine the design system per the "refined E" rules: lines, color, icons, radius, spacing, type, motion; dark and light together.
3. Rebuild the conversation page as three columns: title-bar icons, a properties panel, a right panel (decided).
4. Give extensions three slots on the conversation page, linked to each other; let connectors provide inline widgets through MCP Apps (decided; stage B2, decided 2026-10-24).
5. Show tool calls, subagents, human-in-the-loop cards and files in the conversation by the rules in §5.
6. Build a fidelity mechanism (§7): the implementation must be shown to match the reference set, not just "not broken".

**Non-goals**
- Terminal panel, browser panel (decided: not wanted).
- The subagent runtime. This document defines only its UI; the runtime is the ecosystem spec's §11 and its own design.
- Mobile. Narrow-screen rules in §4.4 keep it usable, no more.
- The terminology rename (routes, tables, API names, copy): that is the ecosystem spec's phase 0, independent of this work (decided, 2026-10-24).
- Artifacts (online collaborative documents, spreadsheets, designs; own service, sharing): a separate project C, discussed later (§6) (decided).

**Anti-goals** (a failure even if everything works)
- The result looks "about right" but measured sizes, spacing and colors differ from the reference set.
- The new conversation page loses an existing capability: interjecting, stopping, approvals (all three scopes), questions (including URL elicitation), connect cards, crash resume, reconnect, file upload (button, drag, paste), `/` connector prompts, `@` connector resources, the hook-denial notice, archived full output.
- An extension's card or panel failing slows or blocks the conversation stream.
- Refinement at the cost of legibility: insufficient contrast, or status shown by color alone.

## 3. Split and order

| Project | Content | Depends on |
|---|---|---|
| 0. Reference set | Finalize the canvas with the maintainer: real fonts, `tokens.json`, fixture data, PNGs (§7.1) | — |
| A. Shell and refined E | Design-system tokens and rules (§4.1–4.3), sidebar (§4.4), page header (§4.5), status bar (§4.6); every page moves | 0 |
| B. Conversation page | Three-column layout, extension slots and linkage, display of tools / subagents / interaction / file outputs, file previewers, titles, model switching, kernel and SDK support (§5) | A |
| B2. MCP Apps | Connector widgets from MCP Apps: contract, sandboxed widget route, host bridge (§5.3) | B |
| C. Artifacts | Online collaborative documents / spreadsheets / designs: own service, sharing, online editing (§6) | B |
| Throughout | The fidelity mechanism (§7), built before A, used to accept A, B and B2 | — |

- Order: reference-set finalization with the maintainer → A → B → B2 (decided, 2026-10-24) → C (decided).
- **No dependency on the package ecosystem work** (decided, 2026-10-24): A, B and B2 neither wait for nor block its rename or repository split. Shared seams are coordination points only: the sidebar's labels and routes (follow the rename when it lands), the `ctx.ui` and `file-preview@1` SDK additions (the ecosystem rename must carry them over), and the extension-side changes in todo and `connector-mcp` (made wherever those packages live at the time).
- A ships first as its own PR; B follows. While A is live and B isn't, the current conversation page (PlaygroundPage + ChatPanel tabs) is placed inside the new shell with only the changes the transition needs (designer's call).
- A and B each get their own implementation plan (superpowers:writing-plans), written against the code at that time; this document names current code only to say what is replaced (designer's call).

---

## 4. Project A: shell and refined E

### 4.1 Visual direction

- Keep what makes E recognizable (decided):
  - dark first, dark and light from one set of tokens;
  - the orange accent;
  - the pixel capybara logo;
  - the monospace font as the UI skeleton;
  - high information density;
  - tabular numbers.
- No pixel styles (decided).
- Refinement follows the restraint of the Claude Code desktop client; **its branding and colors are not copied** (decided).

### 4.2 Refinement rules

1. **Lines**
   - Keep only the dividers between columns, in a color softer than today's `line`.
   - Sections, cards, tool groups and property sections have no border; they are separated by background tint.
   - Only things floating over content get a 1px border: inputs, inline cards, pending cards, overlays.
2. **Color**
   - Success, done and connected are **not colored**.
   - Color is only for failure, things needing a person (approval, connect), things happening (spinner, cursor) and the primary action.
   - Accent roles (design spec §2.3): "current top-level navigation" changes from an underline to a tinted background, because the sidebar is vertical; the other four roles stay.
   - Status encoding (design spec §2.4): in high-frequency lists (tool rows, todo items) success is shown by **no mark**, failure by the word "Failed" in `fail`. Status still always has text.
3. **Icons**
   - One line-icon set site-wide: 24 grid, stroke 1.5, sizes 16 / 14 / 12.
   - No more characters as icons (`▾ ✓ ◐ › ●`, the `⠿` spinner, `▤`).
   - Icons are components in `packages/design`; `apps/web` must not import an icon library (already enforced by `web-ui-import`).
   - Source (drawn in-house or an open-source set's SVGs) is up to the builder, as long as the style is consistent (designer's call).
4. **Radius**
   - Inputs, buttons, inline cards, property sections, overlays: 4 to 8.
   - Message bubbles: 10.
   - Tables and page structure: square.
   - The spec's "radius 0 site-wide" rule changes accordingly (designer's call; the maintainer accepted it after seeing the canvas).
5. **Type**
   - Sarasa Mono SC stays the UI skeleton: navigation, labels, buttons, tables, tool rows, key names, paths, numbers, the status bar.
   - **Conversation prose, rendered Markdown, and descriptive text in forms and page headers** use a proportional font: a Latin sans paired with Source Han Sans, 15px, line height 1.75 (decided).
   - The spec's "the only font on the site" rule changes accordingly.
   - The proportional font is self-hosted and subset like Sarasa today (`packages/design/src/fonts`, OFL).
6. **Conversation width**: the chat column is at most 720 wide, centered.
7. **Motion**
   - Hover background transitions 120–150ms.
   - Height transitions on expand and collapse.
   - Running work shows a spinner and elapsed time.
   - A cursor at the end of streaming text.
   - `prefers-reduced-motion` is respected.
8. **Shadow**: the composer floats at the bottom with one light shadow (one value each for dark and light). Other shadows keep the current tokens.

### 4.3 Sizing system ("compact and refined", 紧凑精致)

The target is "smaller spacing, more compact, looks refined" (decided). Sizing is **a set of named scales in the design system, not a single pinned control height** (decided, 2026-10-24). Every size a component uses is a step of one of these scales, stored in `tokens.json` (§7.1) and listed in the component's size table (§7.2); pages never pick sizes.

**Density steps.** Controls and rows come in three steps, and the step is chosen by context, never by taste:

| Step | Used for | Not used for |
|---|---|---|
| `dense` | Inside tables and table toolbars, tool groups and tool rows, inline cards, property sections, the status bar, tag-like chips | Anything a person is expected to read at length or aim at often outside a dense container |
| `default` | Everything else: buttons, inputs, selects, segmented controls, filter chips, the composer's controls, sidebar items, menu items, form fields | — |
| `prominent` | At most one per view, where the action *is* the page: the auth pages' submit, an empty state's first action, the onboarding checklist's next step | Ordinary page-header primaries, form submits in the action row, dialogs |

Rules:
- A container sets the step for what it holds (a DataTable is `dense` throughout; a form is `default` throughout); mixing steps inside one row is not allowed.
- Icon buttons are square at the same step's height.
- The page-header primary action and the action-row actions are `default`.

**Scales and starting values** (all numbers are (designer's call), to be confirmed or adjusted during reference-set finalization, §7.1):

| Scale | Steps | Starting values |
|---|---|---|
| Control height | `dense` / `default` / `prominent` | 24 / 28 / 32 |
| Row height (lists, tables, sidebar, menus) | `dense` / `default` / `roomy` (rows with a thumbnail or two lines) | 28 / 32 / 44 |
| Spacing | `1`–`8` | 4, 8, 12, 16, 20, 24, 32, 40 |
| Inner padding (inside a component) | `dense` / `default` | 4/8 · 6/12 (vertical/horizontal) |
| Type (monospace UI) | `micro` / `small` / `body` / `h2` / `h1` | 11 / 12 / 13 / 16 / 20 |
| Type (proportional prose) | `prose` | 15, line height 1.75 |
| Stat value | `metric` | 18 |
| Radius | `sm` / `md` / `bubble` | 4 / 8 / 10 |

Spacing usage: inside components spacing steps 1–3; between components 2–3; between sections 4–6; page gutters 4–5. **If spacing can separate it, don't draw a line.**

Starting points for specific components (designer's call; finalized with the reference set): table cell padding 6 vertical; stat cards padding 8/12 with gap 8; form field cards padding 14, 12 between fields; inline file cards padding 6/10, icon 16, min width 240; the composer padding 8/12, radius `md`.

### 4.4 Left sidebar (replaces the TopBar, on every page)

What it replaces: the TopBar (`packages/design/src/shell/top-bar.tsx`, filled by `apps/web/src/components/shell/{AppFrame,nav}.tsx`) carries the logo, org switcher, top-level nav (Overview · Agents · Skills · Inbox with pending count · Connectors · Directory (the org catalog, route `/directory`, member+) · Channels (admin) · Evals (admin) · Admin (enterprise admin)), an "Extensions" menu of extension pages (`place: "page"`, route `/p/<plugin>/<id>`), ⌘K and the user menu (language, theme, sign out). Org settings (`/settings/*`) currently sit under "Connectors"; the admin console (`/admin/*`) has its own second-level nav.

- Two areas (decided):
  - **Navigation**: the top-level navigation that used to be in the TopBar. Role-based hiding is unchanged (`NavAudience` all / member / admin / enterprise; hiding is cosmetic, the kernel decides).
  - **Conversations**: like Claude's sidebar, a list of conversations **grouped by agent**, with a ＋ next to each group name to start a new conversation with that agent.
- The conversation area is shown on every page, not just the conversation page (decided).
- It lists only the current user's own conversations; each group shows the most recent few with "More"; agents without conversations are not listed; groups are ordered by latest activity. This needs a list API grouped by agent with per-group paging (§5.9) (designer's call).
- Navigation layout (designer's call):
  - "＋ New conversation" is the first item;
  - then Overview · Agents · Skills · Inbox (count) · Connectors · Directory · Channels · Evals (labels as the code names them at build time; "Directory" becomes "Catalog" when the ecosystem rename lands);
  - an **Extensions** group listing the org's extension pages directly (replacing the "Extensions" dropdown), shown only when there are any;
  - **Settings** as its own item for `/settings/*` (personal connections, grants, identities, org, members, org plugins, installed apps, model purposes), instead of hiding them under Connectors; Connectors keeps only the connector list, detail and install (decided, 2026-10-24);
  - **Admin** last, for enterprise admins. The admin console keeps its own second-level nav inside its pages (SettingsPage rail); the sidebar does not swap to admin navigation.
- Top: logo, wordmark, ⌘K search button (designer's call).
- Bottom: account and org switcher; language and theme stay in the account menu (designer's call).
- Width 256.
- Narrow screens (designer's call; exact thresholds are the builder's, based on content minimum widths):
  - below 1280 the sidebar collapses to an icon rail;
  - below 960 it becomes a drawer.
- When the conversation area is long it scrolls on its own; groups can be collapsed.
- The inbox pending count keeps its current behavior (count, `99+`, `n+` when truncated, accessible name includes the count).

### 4.5 Page header

- From "single row: title + metrics + actions" to:
  - row 1: breadcrumb (optional);
  - row 2: title + one-line description, actions on the right.
- List-page key metrics move below the header as a row of stat cards, at most 4–5 (canvas "list page").
- Content width: lists 1080, forms 880, centered (decided). This replaces the Centered body's "180 anchor nav + 760 content, 960 total".
- The header actions rule stays: at most one solid primary; form submit actions never go in the header.

### 4.6 Status bar and action row (decided)

- The status bar **does not span the window**: it sits only in the content area to the right of the sidebar, fixed at the bottom of the content area.
- Style: no background, a soft line above, gray, monospace; height about 26 and type about 11.5px, snapped to the nearest §4.3 steps during finalization (the numbers are (designer's call)).
- Every page has one by default.
- It holds **read-only information only**, no clickable controls:
  - left: path `user@org:route` · page status (`useStatusBar(...)`, as today);
  - right: system status · version · time zone.
- When a page has extra actions (a form's submit area, bulk edits, approval decisions, wizards), an **action row** appears **above** the status bar; both stay fixed at the bottom. The status bar never grows into an action bar.
- The conversation page does the same: the status bar at the bottom of the content area, the composer above it.

### 4.7 Changes to the design spec (`docs/design/spec.md`)

Project A's first task is to change the spec per this section and get it reviewed. The spec stays the single source of rules.

| Spec section | Change |
|---|---|
| §1 Principles | Add "spacing before lines" and "color only for what needs attention"; rewrite "character grid / one monospace font" for two fonts |
| §2.1 Colors | Add the new tokens from `tokens.json` (e.g. `panel-2`, `raised`, `line-soft`) |
| §2.2 Font | Two fonts and what each is for |
| §2.3 Accent roles | Current navigation becomes a tinted background |
| §2.4 Status encoding | The high-frequency list rule |
| §2.5 Sizes | Replace the fixed 24 / 28 / 36 heights and radius 0 with the §4.3 sizing system: named scales, density steps and their usage rules |
| §3 Brand | Logo sizes for the sidebar instead of the TopBar |
| §4 App Shell | "Left sidebar + content area (page header / body / action row / status bar)"; remove the TopBar; the Centered body widths |
| §5 Templates | A "Conversation" template replacing T7 Playground or extending it (builder's choice; only the conversation page uses T7 today); the other templates take the new header |
| §6 Components | New: icon, sidebar, conversation list, tool group and tool row, subagent row, file card, attachment strip, inline card frame, property section, right panel frame, composer (with dropdowns and queue state), diff block, queued message, file preview frame, model / effort dropdowns, untitled-conversation placeholder. Replaced: ToolCallRow's IN / OUT IoBlock layout (§5.5), the TopBar's Extensions menu |
| §9 Enforcement and acceptance | Rewrite per §7 (reference images become the baseline for first acceptance) |

---

## 5. Project B: conversation page

What it replaces: `/chat/[conversationId]` renders **PlaygroundPage** with header "Agents / <agent name>", the message list (`MessageList`, items user / assistant / tool / approval / question / connect / failed) and the composer in the content area, and an Inspector `ChatPanel` with tabs: extension views and embeds (`place: "conversation"`, in contribution order) · Artifacts (files delivered by `sandbox_deliver`, rebuilt from `artifact_created`) · Run (tool calls with archived full output, alert when approvals are pending) · Context (model, usage, connectors used, sandbox status). The last tab is remembered in `localStorage` (`cap.chat.panelTab`).

### 5.1 Layout (decided)

- Three columns: left sidebar, middle column, right area.
- **The title bar belongs to the middle column only**; it does not span the right panel.
- Title bar: conversation title on the left (with ⌄ for rename etc.; titles are model-generated, see "Titles" below). On the right, two groups of icon buttons:
  - group 1, one button: properties panel toggle;
  - a vertical divider;
  - group 2: the panel icons of enabled extensions, then "More ⋮". Icons that don't fit go into "More".
- The open item's icon is highlighted.
- The right area holds one thing at a time: **either the properties panel or one extension's right panel**. Opening one closes the other.
- State A, properties panel open: the panel is part of the middle column; the title bar spans the conversation and the properties panel.
- State B, a right panel open:
  - it is full height;
  - its own header: back (optional), title (with a dropdown to switch), actions, full screen, close;
  - the middle column and its title bar get narrower.
- Properties panel about 300 wide. Right panel 520–600, resizable, width remembered; it is a personal preference, kept in browser storage (designer's call).
- Below the right-panel minimum width, the right area becomes an overlay sheet (designer's call; matches today's "Inspector becomes a Sheet below 1280").
- **Titles** (decided, 2026-10-24): conversation titles are **generated by a model**, not copied from the first message; the person can always rename from the title bar's ⌄ menu. What that needs (designer's call):
  - after the first exchange (the first run that ends with an assistant reply), the kernel enqueues a title-generation job (a queue job, no timers, per the multi-replica rules) that sends a short excerpt of the first user message and reply to a model;
  - the model comes from a new kernel model purpose `title` (kind chat), mapped at deployment or org level like `eval`; when it isn't mapped, the conversation's current chat model is used;
  - the call is logged: its token usage is a `usage` event in the conversation log with purpose `title` (like compaction's), so cost is accounted for; it is not model-visible to the agent, so it needs no `DriftReason` and replays never run it;
  - until a title exists the sidebar and title bar show an "Untitled conversation" placeholder (with the start time); a failed call leaves the placeholder and is retried after the next run ends, with a small bounded number of attempts;
  - a manual rename always wins: once renamed, the title is never regenerated;
  - the title prompt is English; the title is written in the conversation's language.

### 5.2 Composer and status bar (decided)

- **What the dropdowns mean** (decided):
  - the agent dropdown can only be changed in a new conversation; after the first message it is locked, and changing agent means a new conversation;
  - model and effort can be switched any time, take effect from the next message, and stay for the conversation until switched again;
  - a switch is written to the conversation event log, so any model request can still be reconstructed from the log plus the agent version;
  - **which models** (decided, 2026-10-24): any model from the org's enabled model providers, as long as it is the **same kind** as the current one. Conversations switch only between chat (generation) models, e.g. a conversation on DeepSeek can switch to Claude Opus 5.5 at any time; embedding models are never switched mid-conversation, because vector dimensions differ and stored vectors depend on them. There is no per-agent list of switchable models.
- What that means against the code (designer's call):
  - **New conversation**: today the Agents list creates the conversation (`POST /conversations {agentId}`) before anything is typed. With an agent dropdown, "New conversation" opens an empty composer and the conversation is created on first send; the ＋ next to a sidebar group pre-selects that agent. Empty conversations are never created.
  - **Effort** is the standard `effort` knob that a model may declare (`low|medium|high|xhigh|max` subset). The dropdown lists exactly the values the selected model declares; when it declares none, the dropdown is hidden. The default is the agent's saved `modelParams.effort` or the model default. Other knobs (temperature, max output) stay in the agent form.
  - The model dropdown lists the chat models of the org's enabled providers, grouped by provider, with the agent's own model first. The agent's fallback stays automatic and is never picked here; it still applies when the chosen model fails.
  - A model the conversation was switched to that later disappears (provider disabled, model removed) falls back to the agent's model on the next message, with a notice in the conversation.
- **Every switchable control is in the composer.** Its bottom row, in order:
  - ＋ (attachments);
  - agent dropdown;
  - model dropdown;
  - effort dropdown;
  - on the far right, send. While running, send becomes stop.
- Existing composer behavior carries over: Enter sends (interjects while running), Shift+Enter newline, `/` connector prompts, `@` connector resources, file drop and paste, at most 5 attachments, `clientMessageId` dedupe on retry.
- The conversation page's status bar is read-only:
  - left: path and conversation stats (e.g. turns, elapsed time; which ones is the builder's call);
  - right: run status, context usage, version.

### 5.3 Extension slots and linkage (decided)

Extensions can add UI in three places on the conversation page:

1. **Inline card**: inside the conversation, e.g. todo's checklist card.
2. **Properties section**: a block in the properties panel, e.g. "Tasks".
3. **Right panel**: an icon in the title bar that opens the extension's own full panel.

Rules:
- **Linkage**:
  - items in inline cards and properties sections may carry an "open" target: "an extension's right panel + an item in it";
  - clicking it opens that right panel scrolled to that item;
  - the ⤢ in an inline card's title row means "open in the right panel".
- **Not enabled, not shown**: when the extension isn't enabled in the org, its icon, sections and cards don't appear.
- **Both tiers everywhere**: rendered views and embed pages work in all three places, with D13's mechanisms.
- **Extension failure**: only that block shows "Failed to load · Retry"; the conversation carries on (D13's anti-goal still holds).
- **Relation to today's `ctx.ui`** (designer's call):
  - today's `place: "conversation"` (a right-panel tab) maps to the new right panel; existing extensions keep working unchanged;
  - two new places: inline card and properties section;
  - an inline card **hangs off a tool result**: an extension's tool result may declare which view to show there; like `display.summary` it is display-only, recorded in the `tool_result` event, never in the model's context;
  - extensions may not write cards into the event log themselves.
- **Connector MCP Apps** (decided):
  - `connector-mcp` supports the MCP Apps extension: a tool declares a `ui://` resource in its definition, and after a call it renders in the conversation as a sandboxed widget;
  - the title row reads "Widget <tool> from <connector>"; it can be enlarged into the right panel or collapsed;
  - the widget can ask the host to call tools (e.g. a Send button a person clicks); those calls go through policy and approval as usual;
  - sandboxing, messaging and permissions match D13's embed pages; the protocol follows the MCP Apps spec.
- **How far MCP Apps goes** (designer's call): at least render widgets, let widgets call tools (the Send button needs it), and pass theme and size from host to widget; target the latest published MCP Apps spec version at implementation time and name it in the plan.
- **What MCP Apps needs that doesn't exist yet** (designer's call): `connector-mcp` today keeps only `annotations` and one `_meta` hint, so the tool's UI resource declaration must be carried through `connector@1` / `ToolSpec`; the widget HTML comes from the remote server (`resources/read`), so the kernel needs a same-origin, CSP-sandboxed route to serve it (like `/plugin-ui` but for connector content, with no embed token reaching the widget); and `EmbedFrame` stays the only iframe in the UI. All of this ships as **stage B2, right after B** (decided, 2026-10-24); B leaves the inline-card slot ready for it.
- **Built-in properties sections** (designer's call):
  - "Context": usage ratio, model, sandbox status, connectors used (today's Context tab);
  - "Files": the conversation's file outputs (§5.4, §5.8);
  - "Background tasks": running subagents and the completed count, each stoppable and openable (§5.6).
- D13's "Run" tab is dropped; the tool groups in the conversation replace it. Archived full output moves into the expanded tool row ("View full output") (designer's call).

### 5.4 Validating the slots (designer's call)

- The **todo extension** (`plugins/todo`) validates all three places: an inline checklist card, a "Tasks" section, a right panel, and the linkage between them.
- **`example-board`** validates an embed page in the right panel (it already has a `place: "conversation"` embed).
- **File outputs are built in, not an extension** (decided, 2026-10-24). The draft proposed a minimal "outputs" plugin and treated it as a stand-in for Artifacts; those are different things (see the terminology note). The conversation page shows the agent's file outputs (`artifact_created`) as file cards, a "Files" section and a right-side preview panel, built in like Context. Only **previewing** is extensible, through the `file-preview@1` extension point (§5.8).

### 5.5 Tool calls (after Claude Code; canvas "conversation · tool calls")

1. **A single call**: one gray line, no box, e.g. "Used Slack: Search messages #feedback this week · 42 results ›".
2. **Two or more consecutive calls** form a group:
   - the group header is a summary; below it a rounded box, one call per row, dividers between rows;
   - the header **counts by kind** with different verbs: "Ran N commands", "Used N tools", "Read / Edited N files", "Loaded tools";
   - failures add "(N failed)" in `fail`;
   - when a group touches only one object, the header names it, e.g. "Read AURE finance workflow handover.pdf".
3. **Running**:
   - the header says what is happening, e.g. "Running command · 2 done";
   - the running row spins and shows elapsed time.
4. **Each row**:
   - "verb + source: tool title + key arguments + extra info";
   - verb and tool name gray, **key arguments in body color**;
   - prefer the tool's declared title (e.g. the MCP `title`) over its key.
5. **A shell row** shows the `description` the model wrote for the call, e.g. "Generated the final PDF".
6. **Expanding a row**:
   - inputs as a "key: value" list, keys small monospace gray; a command shows as `$ command`;
   - then the output: monospace, max height 120, scrollable;
   - then a line with duration and "Copy output";
   - no IN / OUT labels (this replaces today's `ToolCallRow` + `IoBlock`).
7. **File edits**:
   - expanding shows the diff with line numbers, added and removed lines by tinted background only;
   - the header reads "Edited N files · +a −b".
8. **Large output**: show only the start, then "Output 82 KB, showing first 4 KB · View all"; the full text comes from the existing output archive (`GET .../outputs/:outputId`, `read_tool_output`).
9. **Failure**:
   - the row shows "Failed" with an error summary, e.g. "404 file not found";
   - expanding shows the full error;
   - for shell commands, **a non-zero exit code is a failure**.
10. Tool groups sit between prose; **prose is never collapsed**.
11. A run blocked by an extension's policy hook keeps today's notice naming the extension (`run.hook_denied`); a denied tool call shows as a failed row with the denying extension (designer's call).

### 5.6 Subagents (canvas "conversation · subagents")

- Several subagents collapse into a group like tools:
  - while running: "N subagents running";
  - when done: "N subagents done (M failed) · X calls · duration".
- One row per subagent: status (spinner / done / Failed), a kind tag, task name, call count, duration, `›` at the end.
- **Clicking a row opens that subagent's conversation in the right panel** (decided):
  - header: back, task name, spinner and duration, stop, full screen, close;
  - first, the task the parent agent gave it, as a gray block;
  - then a line naming its agent, model and tool scope;
  - then its own tool groups and prose, styled like the main conversation;
  - the panel has its own status bar at the bottom.
- The row open in the right panel gets a tinted background and an accent bar on the left.
- A subagent conversation is **read-only**: the user can watch and stop it, not message it (decided).
- A row can also expand in place to show a step summary and the result (designer's call).
- The "Background tasks" section lists running subagents: spinner, name, duration, stop, then "N completed ›".
- **Data shape**: per the ecosystem spec §11, a subagent is a child run with its own event log (a child conversation); the parent log records only the dispatch and the result. The right panel reads the child conversation's events through the same event API as a normal conversation (designer's call).
- **Scope**: there is no subagent runtime yet. Project B builds these components in `packages/design` and `/dev/ui` with fixture data and accepts them against the reference set; wiring to real events waits for the runtime (designer's call).

### 5.7 Human in the loop and run states (canvas "conversation · human in the loop")

- **Thinking**: collapsed to "Thought for N seconds ›"; expanded, gray prose with a line on the left.
- **Streaming**: a cursor at the end of the text.
- **Approval**:
  - while pending, it is the **only card in the conversation with an accent outline**:
    - first row: title and tool name;
    - then key arguments as "key: value";
    - buttons: Approve, Approve for this conversation, Always approve (each only when the request allows that scope: `once` / `session` / `always`), Deny… (with an optional reason);
    - on the right, which policy required approval;
  - once handled it collapses to one line: who approved or denied, when, and the reason.
- **Question** (`ask_user` and connector elicitation): options plus "Other" free text, Answer and Skip; when the form has a `url`, it shows as a link with the full address; once answered it collapses to a question-and-answer pair.
- **Connect needed**: the card says which service, why, and "only affects you", with a Connect button.
- **Queue and interject** (decided, after Claude):
  - while running, the composer hint reads "↵ send now, ⌘↵ add to queue";
  - **↵ = interject**, today's behavior;
  - **⌘↵ = queue**:
    - queued messages are **shown in the chat column** as translucent, dashed user bubbles;
    - below each: copy, edit, delete, send now;
    - queued messages go out **one at a time** after the current turn ends, each as its own user message (designer's call);
    - interjecting doesn't touch the queue or jump ahead of it; "send now" on a queued message turns it into an interjection (designer's call);
    - when the run fails or is stopped, the queue pauses and shows "Continue sending"; while waiting for approval or an answer, the queue waits for the turn to actually end (designer's call);
    - a queued message is **not written to the event log** until it is sent, because the model hasn't seen it (designer's call).
  - The queue is conversation state that another replica may act on, so it lives in PG or Redis, not only in the browser (designer's call, per the multi-replica rules).
- **End states**: a thin centered divider, three kinds:
  - Stopped (who, when);
  - Run failed (reason · Retry);
  - Context compacted (how much saved · View summary). Today the web app does not render `compaction_summary` at all; B adds it.

### 5.8 Files (canvas "conversation · files")

- **Attachments in the composer**:
  - images as thumbnails with a remove button;
  - files as a strip: type badge, name, size;
  - a progress bar while uploading (upload goes through the web's same-origin object-store proxy since M7);
  - rejected ones (too large etc.) get a `fail` outline and the reason.
- **Attachments in a user message**: above the bubble, right-aligned.
- **File output cards** (files the agent generated and delivered):
  - type badge, middle-truncated name (keeping the extension), size;
  - clicking opens a preview in the right panel.
- **Several file outputs**: two columns; beyond 4, collapsed to "N more files ›".
- **Image files**: shown inline; hover shows enlarge and download; below, name, dimensions, size. Inline images use the existing `?inline=1` rule (bitmaps only).
- **Text files** (md, txt, csv…): first lines, fading out at the bottom, with "Open". Text is shown as plain text, never as HTML.
- **File paths mentioned in prose**: small clickable monospace chips that open the file in the right panel.
- **File cleaned up**: the card stays, grayed and struck through, with the reason (e.g. sandbox reclaimed).
- **Right-side preview panel** (canvas "conversation · right panel linkage"):
  - header: type badge, file name with a dropdown to switch between the conversation's files, version, download, full screen, close;
  - the body is whichever previewer handles the file (below); with none, a file card with type, size and Download.
  - No "Share": sharing belongs to Artifacts (project C), not to file outputs. The canvas's Share button on the file preview is dropped (designer's call).

**File preview is an extension point** (decided, 2026-10-24). Designer's call on the shape:
- A new extension point `file-preview@1`: an extension declares which files it previews (MIME types and / or file extensions, with a size limit) and renders a preview either as a rendered view (`UiView` blocks) or as an embed page. Several extensions may provide it; the org admin can order or disable them, and the person can switch previewer from the panel header when more than one applies.
- The extension gets the file through a short-lived, read-only grant for that one file in that conversation, minted by the kernel after checking the viewer can read the conversation; it never gets the kernel's storage prefix or other files. An embed previewer receives the file through the message bridge, not as a URL the page could share.
- Built-in default set (web + kernel, no extension needed): images (bitmaps; SVG is not rendered inline), plain text and source code (monospace, no syntax execution), Markdown (rendered by the design system's Markdown rules, no raw HTML), CSV / TSV as a table with a row limit. PDF, Word, spreadsheets with sheets, slides and the rest come from extensions; without one they show the file card and Download.
- Previewers never run in the conversation stream: a slow or failing previewer affects only the panel ("Failed to load · Retry"), and falls back to the file card.
- The previewer slot is the same right-panel frame project C will use for Artifacts, so C can add an "open as artifact" action later without changing it.

### 5.9 Kernel and SDK support

| Change | Why |
|---|---|
| `sandbox_bash` gets a **required** `description` argument stating what the command is for; the tool description says so | The shell row shows the model's intent (§5.5 item 5) |
| A non-zero exit counts as a failure: the result carries a structured exit code and the display uses it (today `isError` is only set on timeout or abort) | Group headers count failures |
| Tool kinds: command, read file, write / edit file, search, connector, meta (e.g. `tool_search`, `skill_load`) | Verbs and per-kind counts |
| Tools may declare key arguments and a title; `ToolSpec` gains a title and `connector-mcp` keeps the MCP `title` (today it only uses it as a description fallback) | Row wording (§5.5 item 4) |
| `sandbox_edit` / `sandbox_write` results carry a diff, or enough to compute one (today only "Edited <path>") | §5.5 item 7 |
| Per-call duration (from `tool_call_started` / `tool_result` times), kept by the web app | Duration in expanded rows |
| Queued messages: new conversation state and API (add, edit, delete, send now), in PG or Redis | §5.7 |
| Mid-conversation model and effort switches: a new field on the message or conversation plus a log event recording the switch, with a matching `DriftReason`; replay and evals must honor it. Plus a member-readable list of the org's switchable models (chat kind, enabled providers only) for the dropdown | §5.2; the replay invariant |
| Conversation creation on first send, with the agent chosen in the composer (or `POST` + first message in one call) | §5.2 |
| Conversation titles: a title-generation queue job after the first exchange, a kernel model purpose `title` (falls back to the conversation's current chat model), a `usage` event with purpose `title`, retry while untitled, and `PATCH` rename that stops regeneration (`title` exists today, nothing sets it) | §5.1 titles |
| Sidebar list API: the user's conversations grouped by agent, each group pageable | §4.4 |
| A file-outputs list API for a conversation (today the web app rebuilds it from the log) | Files section and preview panel |
| The `file-preview@1` extension point: SDK types, registration, per-file read grants, admin ordering; built-in previewers in web | §5.8 |
| `ctx.ui` extension: places go from "conversation tab / page" to "inline card / properties section / right panel / page", plus "open" targets; existing `place: "conversation"` keeps working | §5.3 |
| (Stage B2) MCP Apps in `connector-mcp`, carried through `connector@1`, plus a sandboxed route for widget HTML | §5.3 |
| Subagent event shapes: dispatch, progress, finish, child conversation (decided with the subagent runtime design) | §5.6 |

Anything here that changes what the model sees (e.g. the `description` argument) follows "the conversation event log is the single source of truth", runs the zero-drift fixture tests (`replay-evals`), and keeps model-facing text in English (`pnpm check` tool-design rules).

---

## 6. Project C: Artifacts (intent only)

- **What Artifacts are** (decided, 2026-10-24): online, collaborative documents, spreadsheets and designs, created and edited in place, by people and agents, and shareable. They are **not** the files an agent delivers from its sandbox; those are file outputs (§5.8), built into the conversation page.
- The maintainer's earlier idea still holds (decided): an extension-backed plugin, installed by default, running its own service that stores the documents (html, md and the like) so they can be shared; eventually as capable as Claude Artifacts, including online design.
- Not designed here; discussed after B (and B2).
- What B leaves for it: the right-panel frame (C opens artifacts in it) and the extension slots. File outputs do not reserve a "Share" button; whether a file output can be turned into an artifact is C's decision.
- Naming (designer's call): the kernel's identifiers for delivered files (`artifact_created`, `/artifacts/:id/download`, `ArtifactsTab`) are historical. UI copy calls them "files" (zh 文件) from B on; the zh word 产出物 is reserved for Artifacts. Renaming the kernel identifiers is optional cleanup, coordinated with the ecosystem rename, never a precondition for C.

---

## 7. Fidelity mechanism (throughout A, B and B2)

**The problem**: the screenshot regression in `apps/web/visual/` uses the implementation's own screenshots as the baseline. It catches breakage; it cannot prove the implementation is right. This time the **reference set** becomes the baseline.

### 7.1 Finalize the reference set (before A)

Done by one Claude session together with the maintainer, on the existing canvas, as step 0 before A's plan (decided).

1. **Same fonts**: the reference set uses the real fonts (the Sarasa Mono SC subset plus the chosen proportional font), uploaded to the canvas. Today's canvas uses web substitutes and cannot serve as a baseline.
2. **Extract values**: colors, spacing, radii, sizes, line heights, shadows, motion durations, all into `docs/design/tokens.json`, dark and light.
   - the canvas reads from it;
   - `packages/design/src/styles/tokens.css` is generated from it, with a check that the two agree.
3. **By component and state**: one block per state of each component, with **fixed fixture data** (same copy, same counts). The fixtures are stored once and `/dev/ui` uses the same file.
4. **Reference images in the repo**: one PNG per block, dark and light, in `docs/design/reference/` (the design spec already points there; it doesn't exist yet), plus the canvas source so it can be edited later.
5. **Sign-off by the maintainer**; afterwards, changes to the reference set go through the spec's §10 change process.

### 7.2 Size tables and measuring tests

- Each component in spec §6 gets a **size table**: height, padding, gaps, radius, font size, line height, and the color token per state. Values come from `tokens.json`.
- Playwright **measures** `/dev/ui`: element boxes and computed styles against the size table; outside tolerance fails.
- jsdom can't measure layout, so these tests are Playwright only.

### 7.3 State coverage check

- Each component lists its required states in the spec (default, hover, focus, disabled, error, running, failed, empty, loading…).
- A check confirms `/dev/ui` has a block for every state; a missing one fails.
- The check has a violating-fixture test, proven red first.

### 7.4 Side-by-side acceptance

- After each task, generate a "reference | implementation" side-by-side page, dark and light, covering every state the task touches.
- First an **image-reviewing subagent** compares them and lists differences by severity:
  - severe: different structure or layout, missing state, wrong color;
  - moderate: size or spacing off;
  - minor: rendering details.
- Severe or moderate differences block the merge.
- Finally the maintainer reviews the side-by-side page.
- No pixel diffing: font rendering differences cause false alarms; the measuring tests (§7.2) carry the pixel-level constraints.

### 7.5 Interaction spec

- Hover, focus, expand / collapse motion, keyboard (↵, ⌘↵, Esc, arrows), and right-panel switching and closing are written into the spec.
- Covered by Playwright interaction tests.

### 7.6 Existing screenshot regression stays

- Once a change passes side-by-side acceptance, new baselines are generated with the `visual-update` workflow and keep guarding against breakage.

### 7.7 CI placement (designer's call)

- The measuring, state-coverage and interaction tests run with the existing `visual` job (by diff: `apps/web/**`, `packages/design/**`); the `tokens.json` ↔ `tokens.css` check is cheap and runs in full inside `pnpm check`. Each new check states full vs. diff in its PR and updates `AGENTS.md` and `ci.yml` comments, per the CI rules.

---

## 8. Constraints

- Dependency direction, `check:web-ui` (`apps/web` writes no styles, iframes only via `EmbedFrame`, templates enforced) are unchanged. New components and templates change the spec first and go through the change process.
- UI copy goes through i18n (zh and en) and uses the names the code has at build time, following the ecosystem rename when it lands; "files" and "Artifacts" are never used for each other. Model-facing text (tool descriptions, the `description` argument, errors) is English.
- Multi-replica: queued messages, extension refresh, subagent state live in PG or Redis.
- Dark and light ship together; all contrast meets WCAG AA.
- Every new automatic check has a violating-fixture test, proven red first.
- Screenshot baselines are generated only in CI's Linux Playwright image (`visual-update`).
- **Release**: UI work ships in the web image, so each UI PR adds a changeset on `@capybara-hq/web` (fixed group with `@capybara-hq/capybara`; `@capybara-hq/design` is private and needs none). Kernel changes add a changeset on `@capybara-hq/kernel`; SDK changes (`ctx.ui` places, `ToolSpec` title, `file-preview@1`) regenerate `api/plugin-sdk.api.md` (`pnpm gen:sdk-api`) and add a changeset bumping `@capybara-hq/plugin-sdk`; changed official extensions (todo, `connector-mcp`) bump their own packages.
- **Package ecosystem work is a coordination point, not a dependency** (decided, 2026-10-24): extension-side changes (todo's new places, MCP Apps in `connector-mcp`) go wherever those packages live at the time; if the repo split has happened, that is a paired PR in `capybara-hq/plugins` against the published SDK. The ecosystem rename carries the new SDK surface (`ctx.ui` places, `file-preview@1`) over like everything else.
- **SDK compatibility**: existing extensions using `place: "conversation"` keep working without changes.

## 9. Reference set (canvas rows)

| Row | Content | Status |
|---|---|---|
| 1–2 | Current E (Terminal), and the three pixel styles (dark / light) | Comparison only; the rejected pixel styles are not built |
| 3 | Refined E · conversation page (proportional prose / monospace prose / light) | Direction |
| 4 | Refined E · list page, form page (dark / light), sidebar components | Direction |
| 5 | Conversation interactions (dark): tool calls, human in the loop, subagents and inline panels, files, right-panel linkage, subagent right panel | Direction |
| 6 | Conversation interactions (light) | Direction |

The canvas sample text borrows names and projects from the maintainer's real work; they are replaced with placeholders when the reference set is finalized (§7.1). Finalization also updates the canvas copy to the code's current names, replaces the file preview's Share button (§5.8), and re-draws sizes on the §4.3 scales.

## 10. Left to the builder

- Names of components, templates, APIs and SDK methods.
- Whether "Conversation" is a new template or extends T7.
- The icon source, and the Latin face for the proportional font (must pair with Source Han Sans).
- The sidebar breakpoints and the right panel's min and max widths.
- The concrete numbers of the §4.3 scales, confirmed with the maintainer during reference-set finalization.
- Measuring tolerances; suggested ±1px for sizes, colors must equal the token.
- Which stats go on the left of the conversation status bar.
- The storage and API shape of queued messages.
- The exact contract of `file-preview@1` (within §5.8) and the title job's retry limit.
- Task breakdown, decided by each plan.

## 11. Open questions for the maintainer

None at this revision. The six questions of the 2026-10-24 revision were answered by the maintainer the same day and are recorded in place, marked (decided, 2026-10-24): switchable models (§5.2), independence from the package ecosystem work (terminology note, §3, §8), MCP Apps as stage B2 (§3, §5.3), file outputs vs. Artifacts and file previewers as an extension point (terminology note, §5.4, §5.8, §6), model-generated titles (§5.1, §5.9), and Settings in the sidebar (§4.4). The maintainer also replaced the single control height with a sizing system (§4.3).
