# Task 9 report: ConversationPage, TracePage, ListPage loading, one bar look

Commits (not pushed):
- `a4767f8f` refactor(design): one skeleton bar look
- `a7bbb8ca` feat(design): conversation, trace and list loading states

## What was built

### ConversationPage (`packages/design/src/templates/conversation-page.tsx`)
- Prop `loading?: { thread?: boolean; title?: boolean; rightArea?: boolean }`, per part.
- `thread`: `LoadingThread` fills the real `.cb-conv-thread` inside the real `.cb-conv-scroll`, so the scrollbar gutter is unchanged. Three `data-part="loading-turn"` items:
  - a `.cb-user-msg` holding a bubble-box slot (the bubble's padding and 1 px border, 45% wide, right-aligned) with a `prose` bar;
  - two `prose` bars, 100% and 70%.
- Composer: always the real node, in the same `.cb-conv-composer`. While `thread` loads the wrapper is `inert`.
  - The element stays mounted when loading ends. `SkeletonGroup` got an `active` flag, so toggling `loading` does not remount the tree and a typed draft survives (tested by element identity).
  - Caveat: `inert` is the page-level "disabled". The page cannot disable a ReactNode, so web callers can additionally disable their own controls.
- `title`: new `TitleBar.loading`. The path and every icon stay real. The title menu is replaced by `span.cb-title-btn[data-loading]` (30% of the bar) holding a `body` `SkeletonText`.
- `rightArea`: an open area draws its own loading state; a closed area stays closed.
  - `panel` becomes `<RightPanel state="loading" title={t("panel.label")}>`, which is the §6.16.18 loading state, reused.
  - `properties` becomes `PropertiesPanel` with two `PropertySection state="loading"` (上下文 / 文件).
- One `role=status` for the whole page: the root contents sit in a `SkeletonGroup active={anyLoading}`.
  - `SkeletonBars` (used by RightPanel and PropertySection loading) now announces only outside a group.
  - The CSS rule `.cb-conv-page … > .cb-conv-panel` became a descendant rule, because the group is `display: contents`.

### TracePage (`trace-page.tsx`)
- `loading?: { spans?: number; stats?: number }`.
- Stats: real `metrics` stay; otherwise `LoadingStats` (default 4) in the head frame.
- Waterfall: `spans` rows (default 6) in the loaded `.cb-waterfall` / `.cb-waterfall-row` with the same four cells (name, track, status, ms). A `body` name bar (70% / 55% alternating) and a `body` duration bar. No hover or pointer for loading rows.
- Detail: `LoadingCards(1)` in `.cb-trace-detail`.

### ListPage (`list-page.tsx`)
Checked against the shape rule. Four boxes differed from the loaded page, so it changed:
1. An unknown title was an empty h1. It now uses `loadingHeader`, so the title becomes a bar.
2. Several announcements. It now sits in one `SkeletonGroup`.
3. ObjectList used old 12 px hover bars. It now uses the mark box plus two `body` bars.
4. The records fallback used 20 px hover rows. It now uses `body` bars. `loading` also accepts `{ table }`, the caller's table shape, which draws the DataTable's own loading state as InboxPage does.

Props: `loading?: boolean | { rows?; stats?; table? }`, exported as `ListLoading`. `true` stays backward compatible. The only app caller that sets `loading` (marketplace entries) passes a boolean. Tab counts stay "–" (`pending`). The action row, when present, is disabled while loading.

### One bar look (spec §6.6, §6.17, §6.20, §6.29)
- `Skeleton({ rows })`: full-width `SkeletonText` rows. `.cb-skeleton-row` is removed.
- ObjectList loading: `SkeletonBox mark` plus `SkeletonText` 30% / 55%. `.cb-object-bar` and the `data-skeleton` mark rule are removed; the `data-skeleton="true"` attribute stays.
- PendingState bars: same height and radius, ground `hover` → `selected`.
- **Real bug found and fixed.** `conversation-page.css` defined a second `.cb-skeleton-bar` with `width: var(--cb-skeleton-w, 60%)`. It loaded after `display.css`, so every `SkeletonText` bar was 60% of its slot. The text bar width is now `var(--cb-skeleton-w, 100%)` in `display.css`, and the duplicate rule is deleted. The block bars (`SkeletonBars`) still set `--cb-skeleton-w` per bar.
- New `prose` `SkeletonText` size (`type.prose.line`), with a size row in §6.29 and a block in the skeleton reference.
- §6.29's "not yet reconciled, Task 9" bullet is replaced by "One look everywhere".

## Spec
- §5.1 loading rewritten. States `page`, `default-objects`, `loading-objects`, with size rows.
- §5.4 Loading bullet. State `loading`, with size rows.
- New §5.11 Trace (T8). States `default`, `loading`, with size rows.
- §6.17, §6.20, §6.29 updated.
- §6.6 (DataTable) was already the same bar look, so it was not edited. §6.29 lists it among the places that share it.

## /dev/ui blocks, reference and acceptance
- `template-conversation-loading`, built from the file-panel fixture with all three parts loading.
- `template-list-default-objects` and `template-list-loading-objects`.
- `template-trace-default` and `template-trace-loading`. `template-trace` is added to `accepted.ts`, `routes.tsx`, `render.spec.ts` and `review-page.mjs`.
- Reference sources:
  - `template-conversation.html` (+ `conversation.js` `loading` state) draws the new `template-conversation-loading` block.
  - `template-list.html` (+ `fill.js` `list-loading-objects`) draws the new `template-list-loading-objects` block.
  - New `template-trace.html` (+ `fill.js` `trace-loading`) draws the new `template-trace-loading` block.
  - `index.html` links to the new trace page.
- `reference.css` adds the r-wf, r-trace, r-bubble-slot and pending-count rules.
- The trace waterfall loading row count equals `TRACE_SPANS.length` (11), passed as `spans`.

## TDD evidence
- RED: `pnpm exec vitest run packages/design/test/templates-loading.test.tsx` → 12 failed / 31 passed (43). The new Conversation, Trace and List cases failed, including `ConversationPage loading draws the frame and no children`, `composer keeps its box while the thread loads`, `TracePage loading draws the frame and no children` and `list loading boxes equal loaded boxes`.
- GREEN: the same file → 43 passed.
- `pnpm exec vitest run packages/design/test apps/web/test` → 2306 passed. The catalog test also checks every new size-table row against a block and a part. It first failed on the `prose` row until the skeleton block got a `prose` line.
- `pnpm check` → all passed.
- `pnpm typecheck` → passed.
- `pnpm exec biome check packages/design apps/web` → clean (2 existing CSS specificity warnings).
- Playwright not run (Task 9b).

## Self-review against the lessons
1. Containers: the loading thread uses `.cb-conv-thread` / `.cb-user-msg`; trace rows use `.cb-waterfall` / `.cb-waterfall-row`; list rows use `.cb-object-list` / `.cb-object-row`. No added titles, gaps or wrappers.
2. Exactly one `role=status` is asserted in every new test (`busy()` counts `[role=status][aria-busy=true]` on the conversation page, because the status bar can carry its own `status` when it has run state).
3. The /dev/ui and reference HTML blocks draw the same shapes. The reference was hand-matched and is unrendered; the reference PNGs and the Playwright measurement are left to 9b and the reference-update workflow.
4. New props are optional. Existing behaviour is unchanged except the intended list and Skeleton looks.
5. Phones: placeholders reuse the loaded classes, so the `max-width: 639px` rules of the object row, title bar, thread and composer apply unchanged.

## Concerns / for 9b
- `inert` is the composer's disabled state, with no dimmed look. If the spec wants a disabled look, say so.
- `loading.rightArea` makes the page choose the panel title (`panel.label`) and the properties sections (Context, Files) itself. Real extension sections are unknown while loading.
- The loading user bubble is a transparent bubble-box with a bar, because a `selected` bar inside a `selected` bubble would be invisible. Its height equals a one-line bubble's.
- The trace detail placeholder is one generic card. The loaded detail is a caller-defined column.
- A visual diff of Skeleton dialogs in apps/web is expected, since 20 px hover rows became 12 px `selected` bars in 20 px slots.
- The reference HTML for the new blocks was not rendered here (no Playwright). The trace and list loading `r-tpl-head` and body paddings were mirrored from the Task 7–8 loading blocks and may need a nudge in 9b.

## Fix round 1
Changes:
1. ListPage and TracePage always render `<SkeletonGroup active=...>`, so toggling `loading` never remounts the page (header search, tabs, action row). Tests: the ListPage search input is the same node and keeps focus across false→true→false; the TracePage head and body keep their node identity.
2. The composer is no longer `inert`. `ConversationPage.composer` may be a function receiving `{ sendDisabled }` (true while `loading.thread`); the caller passes it to the composer's `send.disabled`. The textarea stays editable and focusable. Tests: textarea focus and node identity survive loading true→false→true, and the send button is disabled exactly while loading. Spec §5.4 now says it cannot send while the thread loads. The dev block uses the function form.
3. The loading properties panel draws only the Context section; spec §5.4 is updated. The reference HTML draws no properties panel, so it needed no change.
4. `loading.rightArea` is `true | { title }`. The loading panel takes the caller's title (dev and reference blocks use "文件"). `RightPanel.onFullscreen` is now optional and the button is omitted while loading. Tested.
Commands: `pnpm exec vitest run packages/design/test apps/web/test` → 127 files, 2309 passed; `pnpm check` → all passed; `pnpm typecheck` → clean; biome → clean (2 existing CSS warnings).
