# Task 9 report: greeting, agent row and panel, quick actions

Status: DONE. Commit `1ca993f4` (`feat(design): greeting, agent row and quick actions for a new
conversation`), pushed to `fix/rc2-acceptance`.

## What was built (props Task 10 uses)

All exported from `@capybara-hq/design`.

- `Greeting({ text?, sub?, still? })` (`packages/design/src/conversation/greeting.tsx`)
  - `text` absent/null: the mark plus an empty, same-height placeholder (`data-part="greeting-placeholder"`);
    pass the line once it is picked on the client.
  - Types once at `GREETING_TYPE_MS` = 40 ms/char with an `accent` caret; the caret goes when
    complete; a re-render with the same text does not retype (StrictMode double effect restarts
    cleanly). Reduced motion (`matchMedia("(prefers-reduced-motion: reduce)")`) or `still`: whole at once.
  - `sub` default is design i18n `greeting.sub` (「选一个 agent，或从常用任务开始」 / "Pick an agent, or
    start from a common task"); `sub={null}` hides it.
  - A11y: `h2` whose name is a `cb-sr-only` full copy; the typed span and caret are `aria-hidden`.
  - Mark: `bitmapCells(CAPYBARA_BITMAP, 2)`, 28x20 in a control.default x space.5 box (as the working line).
- `AgentRow({ agents, selected?, onSelect, max = 5, recent?, moreLabel?, label?, referenceOpen? })`
  (`agent-row.tsx`); `agents: AgentRowItem[]` = `{ id, name, description?, avatar: AvatarValue }`.
  - <=1 agent: renders `null`. Chips: `Avatar` 24 + name, `aria-pressed` on the selected one,
    description as tooltip. More than `max`: first `max`, then 「更多 +N」 (`agents.more`); a
    selected agent past `max` takes the last slot (so the selection always shows).
  - 「更多 +N」 is a Radix popover trigger; the popover is anchored (`RP.Anchor`) on the row, `cb-popover`
    look, as wide as the row (max `layout.chat`). Selecting closes it.
  - `recent`: ids, most recent first, for the panel's 「最近用过」 group. Task 10 must pass it.
- `AgentPanel({ agents, recent?, selected?, onSelect, onClose, defaultQuery?, inline? })`
  - The search is a combobox (`aria-activedescendant`) over a listbox with two option groups:
    「最近用过」 (recent ids in order, omitted when empty) and 「全部 N 个」 (N = matching count).
    The search matches name or description, case-insensitively. No match: no listbox, one quiet
    `role=status` line 「没有匹配的 agent」.
  - ↑/↓ move (wrapping), Enter selects, Escape calls `onClose`. Inside the row, Radix also closes
    and returns focus to 「更多」 (tested).
  - Rows: `Avatar` 28, the name (600), then the description on the same line (small, muted, ellipsis).
- `QuickActions({ items, onPick, max = 4, moreLabel?, label?, referenceOpen? })` (`quick-actions.tsx`);
  `items: { id, title }[]`, `onPick(id)`.
  - Muted, small text-link buttons with no ground or border, ink on hover and focus-visible.
  - One line; titles shrink with an ellipsis, and the full title is the `title` tooltip.
  - The first `max` show; the rest are in a `ConvMenu` behind a quiet 「更多」.
  - No items: `null`.
  - Bodies stay in the page. Task 10 maps `quickActions[i]` to `{ id: String(i), title }` and looks the body up in `onPick`.
- `ConversationPage.newConversation` is now `{ agentName?, description?, greeting?, agents?, quickActions? }`.
  - Top to bottom: `greeting` (otherwise the old name/description), `agents`, `quickActions`, then the composer.
  - With a `greeting`, the column has `data-start="true"`: `space.4` gaps and no extra composer margin.
  - The old form still works unchanged.
- `ComposerBox` `pickers.agent` is now optional (spec §5.4: no agent picker on the new conversation
  page). Task 10 can drop it there.
- Design i18n keys (zh/en): `greeting.sub`, `agents.label|more|panel|recent|all|search|empty`,
  `quick.label|more`.
- `COLLISION_PADDING` exported from `overlays/menus.tsx` (reused by the agent panel).

## Spec, catalog, reference

- `docs/design/spec.md`:
  - New §6.16.25 Greeting (states `default`, `placeholder`).
  - New §6.16.26 Agent row and agent panel (`default`, `panel`, `no-match`).
  - New §6.16.27 Quick actions (`default`, `hover`, `menu`).
  - Each has a size table.
  - §5.4's new-conversation bullet is rewritten for the new layout and the slots. `template-conversation` has 4 new `new` rows (row-gap, greeting-line height, agent-chip height, quick-action colour); its state list is unchanged.
  - §6.16.2 notes that the agent picker is optional.
- `/dev/ui` blocks in `apps/web/src/dev/catalog/conversation-blocks.tsx`:
  - New: `greeting-*`, `agent-row-*`, `quick-actions-*`. `quick-actions-menu` is a `RefBlock` 160 high, which leaves room for the menu.
  - `template-conversation-new` now draws the greeting, agents row and quick actions, with the composer's agent picker removed.
  - `routes.tsx`, `accepted.ts`, `reference/render.spec.ts` and `review-page.mjs` list the three components.
- Reference set:
  - New pages `docs/design/reference/src/{greeting,agent-row,quick-actions}.html`, linked from `index.html`.
  - `reference.css` gains `r-greeting*`, `r-agent*` and `r-quick*` rules.
  - `conversation.js`: the template's `new` block uses the new layout and the composer without the agent picker (`noAgent`).
  - The avatar pixel paths are precomputed from `avatar-presets.ts`, as `avatar.html` did. The generator was a scratch script and is not committed.
- Fixture: `NEW_CONVERSATION_FIXTURE` (8 agents, selected, recent, 6 quick actions, no-match query)
  in `packages/design/src/fixtures/conversation.ts`.

## TDD evidence

RED (before any implementation):
```
$ pnpm exec vitest run packages/design/test/new-conversation.test.tsx
 Test Files  1 failed (1)
      Tests  13 failed | 1 passed (14)
```
The one that passed is the regression test "keeps the name and description form without a greeting".

GREEN:
```
$ pnpm exec vitest run packages/design/test/new-conversation.test.tsx
      Tests  14 passed (14)
$ pnpm exec vitest run packages/design/test apps/web/test/catalog.test.tsx
 Test Files  52 passed (52)
      Tests  989 passed (989)
$ pnpm exec vitest run apps/web/test
 Test Files  85 passed (85)
      Tests  1708 passed (1708)
$ pnpm check            -> All checks passed
$ pnpm typecheck        -> clean
$ pnpm exec biome check packages/design apps/web -> 0 errors (2 pre-existing CSS
  noDescendingSpecificity warnings in conversation-page.css:122 and templates.css:426, untouched)
```

## Test titles (packages/design/test/new-conversation.test.tsx)

- Greeting (spec §6.16.25):
  - greeting types once and shows whole under reduced motion
  - without a line yet draws a same-height placeholder with no text, and the default sub line
  - speaks English
- AgentRow and AgentPanel (spec §6.16.26):
  - agent row shows 5 then 更多 +N; the panel searches by name and description
  - panel keyboard: arrows, Enter selects, Escape closes
  - the panel alone calls onClose on Escape and speaks English
  - keeps a selected agent past the first five visible in the row
  - five agents or fewer: no 更多 chip
  - one agent: the row renders nothing
- QuickActions (spec §6.16.27):
  - quick actions show 4 then 更多 and call onPick
  - four or fewer: no 更多; none: nothing
  - speaks English
- ConversationPage new-conversation slots:
  - draws the greeting, the agents row and the quick actions above the composer
  - keeps the name and description form without a greeting

## Files

New:
- packages/design/src/conversation/greeting.tsx
- packages/design/src/conversation/agent-row.tsx
- packages/design/src/conversation/quick-actions.tsx
- packages/design/test/new-conversation.test.tsx
- docs/design/reference/src/{greeting,agent-row,quick-actions}.html

Modified:
- packages/design/src/conversation/{index.ts,composer.tsx}
- packages/design/src/templates/conversation-page.tsx
- packages/design/src/{i18n.ts,overlays/menus.tsx,fixtures/conversation.ts}
- packages/design/src/styles/{conversation.css,conversation-page.css}
- docs/design/spec.md
- docs/design/reference/src/{index.html,reference.css,conversation.js}
- apps/web/src/dev/catalog/{conversation-blocks.tsx,conversation-page-blocks.tsx,routes.tsx}
- apps/web/visual/accepted.ts
- apps/web/reference/{render.spec.ts,review-page.mjs}

## Not run

- The Playwright fidelity, state-coverage and screenshot specs, the reference render, and the side-by-side compare were not run, and no temporary worktree was made. jsdom covers this much: every size-table row's block and part exists (catalog test). The measured px and colours have not been verified.
- Reference PNGs and visual baselines are not regenerated, by rule. The `templates/conversation` screenshot baseline will differ: its new-conversation state changed.
- Neither workflow was triggered.

## Self-review and concerns

1. "Two-column rows" (brief/spec §4.2) is read here as each row being two columns: the avatar, then the name and description on one line in a single-column list, so ↑/↓ stay simple.
   - If a two-column grid of rows was meant, the panel layout and arrow semantics need to change.
2. No changeset was added. `@capybara-hq/design` is private; the web change here is dev-catalog only. Task 10's web patch changeset covers the page.
3. The greeting text uses an `h2` element at `h1` size and weight 600, in the UI (mono) font.
   - The size is a design call the spec left open; it is written into §6.16.25.
4. The greeting text is one line with an ellipsis; a very long name is cut.
   - The "same height" requirement makes the line box fixed at `type.h1.line`.
5. The quick-action overflow menu (ConvMenu, `size="narrow"`) has no max width. A 40-character title gives a wide menu; its text cell does have an ellipsis.
6. Review focus 4 (a quick action replaces the composer text, ⌘Z restores it) is web behaviour. It is not in these components; Task 10's brief owns it and its test. The design side only calls `onPick(id)`.
7. `defaultQuery` and `inline` on AgentPanel, and `referenceOpen` on AgentRow and QuickActions, exist for the reference set and catalog blocks (apps/web may not write `className`).

---

## Fix round 1: commit `91b673f4` (pushed)

`fix(design): a two-column agent panel; IME-safe search; menu and panel sizes`

### What changed

1. **Two-column panel (Important, ruling)**
   - Each group (最近用过, 全部 N 个) is its own grid: `.cb-agent-group`, `data-part="agent-group"`, `repeat(2, minmax(0, 1fr))`, gaps space.1 by space.2. The label spans both columns.
   - New exported `gridStep(sizes, [group, index], key)` and `AGENT_PANEL_COLUMNS = 2`:
     - ← / → move within the row and stop at its ends.
     - ↑ / ↓ move one row and keep the column.
     - Where a row has no option below the current column, ↓ goes to the group's last option.
     - From a group's last row, ↓ goes to the next group's first row; from its first row, ↑ goes to the previous group's last row. Either way it lands in the same column, or the nearest one that exists.
     - At the panel's first and last rows the active option stays.
     - With nothing listed, ← / → keep moving the text caret.
   - The listbox and `aria-activedescendant` are unchanged.
   - Spec §6.16.26 Panel and Keyboard are rewritten. Its size table gains `agent-list` row-gap and `agent-group` column-gap and row-gap.
   - `reference.css` (`r-agent-group` grid, label span) and `agent-row.html` (regenerated) are updated.
2. **IME (Important)**: the search's `onKeyDown` returns at once when `e.nativeEvent.isComposing`. The spec states it.
3. **Menu width**: `ConvMenu` gains `bounded` (`data-bounded`, `max-width: min(320px, calc(100vw - 16px))`). `QuickActions` uses it. This is in spec §6.16.27 and in the reference `.r-quick-menu`.
4. **Panel list height**: `max-height: min(320px, available-height − control.default − 3·space.2 − 2px)`, where the available height is `--radix-popover-content-available-height`.
5. **Greeting tests**: one for StrictMode, one for a new line arriving mid-typing. Both passed without code changes; the behaviour was already there.
6. **`data-start`**: set when any of `greeting`, `agents` or `quickActions` is given. §5.4 says so.

### Test titles added or changed (`new-conversation.test.tsx`)

- types once under StrictMode, one character per 40 ms
- a new line mid-typing starts again from 0 with no stale timer
- panel keyboard: arrows, Enter selects, Escape closes (rewritten: ← / →, ↑ / ↓ across rows and groups, edges)
- panel grid: ↓ with no option below the column goes to the group's last option (unit test of `gridStep` plus the grid CSS)
- the search leaves Enter and the arrows to an IME while it composes
- the list fits the room below the row and the overflow menu has a bounded width
- lays out the start column whenever a greeting, the agents row or quick actions are given

### RED

The new tests were run against the pre-fix source: the `src` diff was reverted temporarily, then re-applied.

```
× panel keyboard: arrows, Enter selects, Escape closes
× panel grid: ↓ with no option below the column goes to the group's last option
× the search leaves Enter and the arrows to an IME while it composes
× the list fits the room below the row and the overflow menu has a bounded width
× lays out the start column whenever a greeting, the agents row or quick actions are given
Tests  5 failed | 15 passed (20)
```

The two greeting tests passed already, as expected: the behaviour existed and the tests now pin it.

### GREEN

```
$ pnpm exec vitest run packages/design/test/new-conversation.test.tsx   -> Tests 20 passed (20)
$ pnpm exec vitest run packages/design/test apps/web/test/catalog.test.tsx
  Test Files 52 passed (52); Tests 995 passed (995)
$ pnpm typecheck -> clean
$ pnpm check     -> All checks passed
$ biome check packages/design apps/web -> 0 errors (the same 2 earlier CSS warnings)
```

### Not run and concerns

- The Playwright fidelity and reference rendering were not run, as before.
- The panel stays two columns at every width; on a phone the descriptions get short.
- Focus after selecting an agent is left to Task 10, as ruled.
