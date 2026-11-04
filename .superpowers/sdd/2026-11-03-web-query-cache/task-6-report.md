# Task 6 report: skeleton primitives and the PageHeader loading state

Status: DONE (with the concerns below).

## Built
- `packages/design/src/display/skeleton.tsx` (exported from `display/index.ts`):
  - `SkeletonText({ width, size })`: bar at the line box of `body` / `small` / `title` (h1), `hover` ground, radius `sm`, aria-hidden.
  - `SkeletonBox({ part, height?, width? })`: `part` = `dense | default | prominent | mark | block`; `selected` ground, radius `sm` (`mark`: 36x36, radius `md`).
  - `SkeletonGroup({ label, children })`: `role="status"` + `aria-label` + `aria-busy` + one hidden `table.loading` text ("正在加载" / "Loading", existing i18n key); nested groups add nothing; `display: contents`.
  - Internal `useSkeletonAnnounces` / `SkeletonAnnouncement` so PageHeader announces itself only outside a group.
- `PageHeader.loading?: { title?, actions?, tabs? }`: unknown title = `title`-size 30% bar and no empty h1; `actions` / `tabs` draw N placeholders (72 px default-control box; 56 px body bar) only when the real list is empty; known actions / tabs render for real; header gets `aria-busy` + hidden text unless inside a group.
- CSS: `display.css` (skeleton-text / box / group), `shell.css` (title bar wrapper, tab slots). No animation. Existing `Skeleton({rows})` untouched; relation documented in spec §6.29.
- Spec: new §6.29 (state list `text, box, group` + size table); §4.2 gains the Loading paragraph, `loading` state and two size rows.
- Reference wiring (page-header is accepted, `skeleton` has a state list, so the completeness test forces it): `/dev/ui` blocks `page-header-loading`, `skeleton-text|box|group` in `reference-blocks.tsx`; `skeleton` added to `routes.tsx`, `visual/accepted.ts`, `reference/render.spec.ts`, `reference/review-page.mjs`; reference sources `page-header.html` (+ `fill.js` loading render), new `skeleton.html`, `reference.css`, `index.html`.

## TDD
- RED: `pnpm exec vitest run packages/design/test/skeleton.test.tsx` -> 7 failed, 1 passed (before implementation).
- GREEN: 8 passed. Tests: "SkeletonText takes the line box of its type size" (reads display.css rule vs tokens.css, jsdom has no layout), "one busy announcement per group", "PageHeader loading keeps the actions it knows", plus width, box, nested header, slot counts, known tabs.

## Verification (all run)
- `pnpm exec vitest run packages/design/test`: 46 files, 787 tests pass (spec-tables included).
- `pnpm exec vitest run apps/web/test tools/checks`: 101 files, 1716 pass.
- `pnpm check` (all custom checks, incl. check:web-ui, check:tokens, check:i18n): pass. `pnpm typecheck`: clean.
- `pnpm exec biome check packages/design apps/web`: 0 errors (2 pre-existing noDescendingSpecificity warnings).
- NOT run: Playwright visual / fidelity / reference render specs (no browser assumed). The new size-table rows for `skeleton` and `page-header-loading` are therefore unmeasured in a real browser.

## Concerns
- Group uses `role="status"` (biome a11y rejects `role="group"` on a div); it is a live region named by `label`.
- `PageHeader.title` stays a required string; loading callers pass `title=""` with `loading.title`.
- No changeset added (design is private; prior design commits used a `@capybara-hq/web` patch changeset). Add one if desired at the end of the plan.
- Reference PNGs for the new blocks come from the `reference-update` / `visual-update` workflows.

## Fix round 1
1. Reverted the stray `role="status"` in §6.16.12 (Question block) to `role="group"`; the only role changes left in the spec diff are in §6.29.
2. One bar look: `SkeletonText` is now a slot one line box high (`.cb-skeleton-text`, flex, centred) holding `.cb-skeleton-bar` (`data-part="skeleton-bar"`, `space.3` high, `color.selected`, radius `sm`). §6.29 text and size table rewritten (slot height = line box; bar rows: space.3, color.selected, radius.sm); old `Skeleton` rows and the ObjectList / PendingState bars are listed as unreconciled until Task 9. Reference HTML/CSS (`skeleton.html`, `fill.js`, `reference.css`) and tests updated.
3. Phone sizes: below 640 the header's action placeholders are 40 high (min-width 40) and the tab slots 40 high, like the loaded parts. New state `narrow-loading` (§4.2 list + two size rows), `/dev/ui` block `page-header-narrow-loading`, reference block, and a CSS test. `apps/web/visual/fidelity.spec.ts` now treats `narrow-*` states as phone-window states (`isNarrow`). Not run in a browser.

Commands: `pnpm exec vitest run packages/design/test` -> 46 files, 788 tests pass; `pnpm check` -> All checks passed; `pnpm typecheck` clean; biome on packages/design apps/web -> 0 errors (2 pre-existing warnings).
