# T0.4 Guards: report

Commit: cd5548d34 `feat(checks): keep size-class logic out of pages and in ClassForms (#605)`.

## What was built
All four are rules of `check:web-ui` (like `design-breakpoint`), so no new script, registry entry or
runner was needed; `pnpm check` runs them. README entries (all "full on PRs: cheap source scan").
- `tools/checks/src/web-ui-responsive.ts` (new): `web-ui-size-branch` (+`SIZE_BRANCH_ALLOWED`, stale
  rule `web-ui-size-branch-stale`), `web-ui-filters-scope` (+`SCOPE_PENDING`, stale rule
  `web-ui-filters-scope-stale`; follows same-file consts, spreads, hook returns, imported hooks),
  `web-ui-template-only-props` (`primaryForm` on PageHeader / in a header object, `look` on Tabs).
  Re-exported from `web-ui.ts`; `checkWebUi` got a 6th param `ResponsiveLists` (defaults = real lists).
- `tools/checks/src/design-dual-render.ts` (new): `design-dual-render` + `DUAL_RENDER_PENDING` ratchet
  (`design-dual-render-stale-pending`); `shell/class-forms.tsx` exempt by path; definition file
  `use-media-query.ts` does not count (it defines `useHydrated`, never calls it).
- Fixtures: `web-ui/{size-branch,filters-scope,template-only-props}.tsx`, `web-ui/filters-scope/owner-filter.tsx`
  (imported hook), `web-ui/responsive-tree/` (tree for allowlist/ratchet tests), `design-dual-render/{violation,ok}`.

## Real-tree verification
- `SIZE_BRANCH_ALLOWED`: AppFrame.tsx, host-api.ts, ExtensionSlot.tsx verified as real uses. LEFT OUT:
  `lib/client-host/api.generated.ts` (only the string "useSizeClass", no import or window read; a
  stale entry would fail). ADDED (they violate today, `pnpm check` fails otherwise):
  `components/shell/conversations.tsx` (useSizeClass + matchMedia coarse prewarm) and
  `components/ScheduleCalendarView.tsx` (matchMedia(SIZE_CLASS_QUERIES.compact) at click time).
  `components/shell` AppFrame/conversations paths exist.
- `SCOPE_PENDING`: all four files verified (agents: Segmented via const `filters`; market: Tabs in a
  conditional spread; both templates views: `useOwnerFilter` (components/AdminComponents.tsx) returns Tabs).
- `DUAL_RENDER_PENDING` (measured, each max 1): shell/body.tsx (useHydrated + useMediaQuery(INLINE_RIGHT_AREA_BELOW)),
  page-header.tsx, sidebar.tsx, app-shell.tsx. No menus pair them. `INLINE_RIGHT_AREA_*` counted as a
  width-class query constant (body.tsx needs it).
- `pnpm check`: All checks passed. `pnpm exec tsc -b tools/checks`, biome, `check:english-comments`: clean.
- `pnpm exec vitest run tools/checks/test`: 39 files, 446 tests pass.

## TDD RED evidence
Tests were written with the fixtures first; a first run before the implementation imports resolved failed
with `ReferenceError: sizeBranchFindings is not defined` (8 failing). For a stronger red after
implementation I stubbed each detector to return [] (size-branch, template-only, filters-scope scan,
dual-render) and ran both test files: `10 failed | 80 passed` (every positive and ratchet test red:
size-branch 3, filters-scope 2, template-only 1, dual-render 4); the negative tests stayed green as
expected. Stubs reverted; full suite green.

## Concerns / notes
- Pending/allowlist lists live in `web-ui-responsive.ts` / `design-dual-render.ts`, not `web-ui.ts` (re-exported there).
- A hook returning a Segmented/Tabs inside a file that also draws a ListPage is reported at both
  the hook's `filters` property and the page (the ratchet counts per file, so no effect on pending).
- `web-ui-template-only-props` has no real-tree hits (props not added yet); proven on fixtures only.
- I did not touch tools/checks/package.json, registry or tools/ci (rules ride on `check:web-ui`, already full).

## Fix round (coordinator review)
RED first: fixture lines added (`size-branch.tsx` 15-29: `design.useSizeClass()`, bare `matchMedia` / `innerWidth`,
and a function that binds those names itself; `template-only-props.tsx` 30-32: two findings on one line);
tests failed 2 (size-branch, template-only) before the fix.
1. `sizeBranchFindings` now flags a namespace import's member (`design.useSizeClass`) and bare
   `matchMedia` / `innerWidth` not bound by an enclosing scope (scoped per function: params and
   declarations; a binding in another function does not hide a global read).
2. `templateOnlyPropsFindings` dedupes on line + message.
3. README: a `header` a hook returns or an imported const holds is not followed (stated; not followed in code).
Result: tools/checks 446 tests pass, `pnpm check` passes, tsc / biome / english-comments clean.
