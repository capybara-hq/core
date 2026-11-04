# Task 7 report: Detail, Overview, Inbox loading states

Commit: d3511d9b `feat(design): detail, overview and inbox loading states` (one commit for all three; they share frame.tsx, the spec and the catalog files).

## Built
- `DetailPage.loading?: { inspector?: boolean; blocks?: number }`: header via PageHeader.loading (`loadingHeader`: title bar when `title === ""`, `header.loading` wins), real PageTabs, `blocks` (default 2) card-shaped blocks instead of children, inspector skeleton only when `loading.inspector` (a real `inspector` stays).
- `OverviewPage.loading?: { stats?: number; sections?: number }` (defaults 4 / 2). Header `metrics` given for real render real instead of stat skeletons. Children replaced by `sections` cards.
- `InboxPage.loading?: { rows?: number }` (default 4 rows of 64 px) plus new optional `filters` (rail top, static, stays real while loading) and `list` is now optional. Content is one card block; real `inspector` stays.
- Helpers in `templates/frame.tsx`: `loadingHeader`, `LoadingStats` (the `.cb-stat-card` box with small label + metric value slots), `LoadingCards` (`cb-card`, `data-part=loading-card`), `LoadingInspector`. Each loading template is wrapped in one `SkeletonGroup` (one announcement, label = title or `table.loading`).
- `SkeletonText` gained size `metric` (type.metric.line, 24) so stat values keep their box (CSS + spec §6.29).
- CSS: `.cb-loading-stack`, `.cb-loading-row` in templates.css. No animation, no TanStack.

## Spec / docs
- docs/design/spec.md: §5.2 loading paragraph + state list/size table `template-detail`; new §5.6 Overview and §5.7 Inbox with state lists (`default`, `loading`) and size tables; §6.29 mentions `metric`.
- Reference sources: docs/design/reference/src/template-{detail,overview,inbox}.html (+ reference.css, index.html), render.spec PAGES and review-page GROUPS.
- /dev/ui: apps/web/src/dev/catalog/template-loading-blocks.tsx (blocks `template-<x>-default` and `-loading` from one fixture), wired in reference-blocks.tsx, routes.tsx (REFERENCE_COMPONENTS), accepted.ts.

## TDD
- RED: `pnpm exec vitest run packages/design/test/templates-loading.test.tsx` -> 7 failed | 3 passed (no `loading` prop / `filters`).
- GREEN: 10 passed (includes "<T> loading draws the frame and no children" x3, "tabs stay real while loading").
- `pnpm exec vitest run packages/design/test apps/web/test/catalog.test.tsx`: 48 files, 883 tests pass (catalog test covers state-block and size-row coverage). `pnpm check` all pass, `pnpm typecheck` clean, biome: only 2 pre-existing warnings.
- Playwright not run (Task 9b).

## Concerns
- Spec did not define the Inbox "rail renders for real" source: I added an optional `filters` prop (list stays required-ish -> now optional). Please confirm.
- Reference HTML header uses the generic loading header (title bar, 2 actions, 2 tabs) while the /dev/ui blocks use a known title; the reference sources only have `-loading` blocks (brief asked only for that), no `-default`.
- Reference sources/PNGs are hand-written approximations; only size-table rows are measured. Detail inspector width (400, from 1280 viewport) is not in the size table.
- In /dev/ui inbox default the list is an ObjectList panel (1 px border) while loading rows are bare; Task 9b box comparison of rail rows may differ by that border.
- Single commit rather than three.

## Fix round 1
1. Inbox loading rows: now `<ul class="cb-object-list" data-part="loading-list">` with `<li class="cb-object-row">` rows, so border, radius and :first-child match the loaded ObjectList (filters sit outside the ul).
2. Detail inspector placeholder: KeyValue's own `dl.cb-kv` with 4 `cb-kv-row` rows (8ch key slot, 55% value slot, body lines), no group title; removed `.cb-loading-stack` row CSS. Size row `loading-inspector-row | loading | height | type.body.line` added to spec §5.2.
3. `InboxPage.loading` is `{ list?: "objects"; rows? } | { list: "records"; table: { label, columns, rowHeight?, framed? } }`; records draw `DataTable state="loading"` in that shape (header columns real). Blocks `template-inbox-default-records` / `template-inbox-loading-records`, states `default-records` / `loading-records` in spec §5.7 with size rows, plus a test. Note: DataTable's own loading carries its own role=status, so the records state has two status regions (the group's and the table's).
4. /dev/ui loading blocks use a title-bar header (`loading: { title: true, actions: n, tabs: 0 }`); fill.js pageHeader accepts `loading: { actions, tabs }` counts; the reference sources use the same counts and the KeyValue-shaped inspector and object-list-shaped rail.
5. `list` typed as required unless `loading` is set (union).
Commands: biome clean (2 old warnings), `pnpm typecheck` clean, `pnpm exec vitest run packages/design/test apps/web/test/catalog.test.tsx` 48 files / 886 tests pass, `pnpm check` all passed. Commit: `fix(design): inbox and inspector loading keep the loaded boxes`.

## Fix round 2
1. `table/empty.tsx` loading branch uses `useSkeletonAnnounces()`: inside a SkeletonGroup it drops `role="status"` and the hidden text (rows stay decorative); standalone DataTable unchanged (tested).
2. Records test asserts one `status` and one "正在加载".
3. `Column<Row>[]` already assigns to `Column<never>[]` (`cell` is method syntax, so bivariant); pinned by a test passing `Column<Row>[]` typed as `InboxLoading` without a cast (checked by `pnpm typecheck`, tsconfig.test.json); the /dev/ui block does the same. `InboxLoading` is exported.
Commands: biome clean (2 old warnings), typecheck clean, vitest packages/design/test + catalog 48 files / 888 tests pass, `pnpm check` passed. Commit `fix(design): one loading announcement inside a skeleton group`.
