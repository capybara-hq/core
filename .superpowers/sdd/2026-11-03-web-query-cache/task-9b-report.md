# Task 9b report

Status: DONE_WITH_CONCERNS. Commits: f9ebdcc5 (spec, `LOADING_TEMPLATES`, ci.yml, AGENTS.md), 67d8fd26
(overview loading block keeps the header description), f29c1409 (width exemptions). Never pushed.

## Method
Temp worktree chore/visual-9b (detached at each commit), Google Chrome via an untracked
`playwright.chrome.config.ts` (`channel: "chrome"`), port 3199. Only `fidelity.spec.ts` and
`skeleton-alignment.spec.ts` ran; no screenshot spec. The temp worktree and branch are removed.

## Spec (apps/web/visual/skeleton-alignment.spec.ts, lists in accepted.ts)
For each of 10 templates (detail, overview, inbox x2 pairs, form, settings, wizard, auth, conversation,
trace, list) in both themes: collect every `[data-part]` box in the loading and the loaded reference
block, relative to the block, key `<part>#<n>`; for parts in both compare x, y, width, height within
1 px. Block pairs: default/loading; inbox also default-records/loading-records; form page/loading; list
default-objects/loading-objects; conversation file-panel/loading (no default block exists).
`VARIABLE_HEIGHT` (content, thread, table, form-section, form-section-head, form-card; later same-name
occurrences also skip y), `VARIABLE_WIDTH` (title, page-header-description), `IGNORED_PARTS`
(link-pending, icon, icon-button) each carry a reason in accepted.ts.

## Runs
- First run (before exemptions): 14 failed. 12 skeleton cases and 2 sidebar fidelity cases. The skeleton
  failures were: content/thread/table/form-section heights (content-driven by the demo's sample data and
  help text), link-pending (off-screen announcer), icon/icon-button (position-indexed, counts differ),
  title width (30% bar vs text), and ONE real defect below.
- Red run, per the brief: hid the page-header title bar in the loading header (temp worktree only, not
  Detail-specific: Detail's own header has actions that keep the row height). Failed overview, settings,
  form, wizard in both themes, e.g. `form loading page-header#0 height: loaded 48, loading 20`.
  Detail did not fail: removing a skeleton-only part (loading-card, loading-inspector) is invisible to
  this spec because the loaded block has no same-named part. See concerns.
- Green run (f29c1409): skeleton-alignment 20 passed. With fidelity.spec.ts: 132 passed, 2 failed
  (sidebar, both themes, pre-existing).

## Fidelity failures
- sidebar (dark, light): `sidebar-item-focus: force selector [data-part="nav-item"][href*="at=inbox"]
  matched nothing`. Identical at 10ec3ebe, so pre-existing; left alone. All Tasks 6-9 components
  (skeleton, page-header, every template) pass their size rows and state coverage in both themes.

## Defects found by the alignment spec and fixed
- Overview loading block omitted the page's static description, so the loading header was 48 px
  against 72 loaded and everything below shifted 24 px. Fixed in the reference block
  (template-loading-blocks.tsx); the design component was right. No loaded box changed.
- Not fixed, a note: the loading action slot is 72 px wide while a real button is as wide as its label, so
  the header description is 20 px narrower while loading. Unknowable; exempt via VARIABLE_WIDTH.

## Files
apps/web/visual/skeleton-alignment.spec.ts (new), apps/web/visual/accepted.ts,
apps/web/src/dev/catalog/template-loading-blocks.tsx, .github/workflows/ci.yml (comment on the visual
job; the job runs `pnpm visual`, which already picks the new spec up), AGENTS.md (visual row).

## Concerns
- The spec checks only parts shared by both blocks; a skeleton part that has no loaded counterpart, or a
  loaded part the skeleton forgot, is caught only through the shifts it causes.
- The exemptions in `VARIABLE_HEIGHT` come from fixture content (help text, row counts), so they weaken
  checks on content/thread/table/form-section heights. Those are measured by the size rows instead.
- Commit 67d8fd26 also carries the exemption lists (spec and block fix in one commit).
- Screenshot regression was not run, per the ruling; reference PNGs and baselines still wait for their workflows.

# Fix round 1

Commits: ea... see `git log`: "skeleton alignment requires every loaded part while loading", "pairs loading
parts by alias; Card and KeyValue carry data-part", "list the loaded parts a skeleton may omit, each with its
reason", "compare the right edge of the header actions while loading". Same method as before (temp worktree,
Chrome channel override uncommitted, port 3199, only fidelity + skeleton-alignment); temp worktree and branch
removed.

## Changes
1. Presence check. Every loaded part, by name and count, must appear in the loading block unless it is in
   `DATA_ONLY_PARTS` (accepted.ts, one reason per entry) or the pair's own `dataOnly` (inbox `card`: one
   card-shaped block while loading; trace `key-value`: the loading trace draws the detail card's text lines).
   A count mismatch is a failure; parts of equal count pair by name+index. `LOADING_ALIASES` pairs a
   `loading-*` part with the loaded part it stands in for (loading-card = card, loading-inspector =
   key-value, loading-inspector-row = key-value-row, loading-switch-list/row = switch-list/row,
   page-header-title-bar = page-header-title, page-header-action-slots = page-header-actions).
   To make cards, the inspector and the header actions visible to the check, the loaded `Card`, `KeyValue`
   (`key-value`, `key-value-row`) and the PageHeader actions container (`page-header-actions`) now carry
   `data-part` (inert attributes; no box changes).
2. `VARIABLE_HEIGHT` is now a record with a reason per entry, and narrowed to content, thread, table, card,
   form-section, form-section-head, form-card. form-section / form-card vary with the fixture's help text
   and paired controls; form-section-head stretches to the section row; card is the loaded section's own
   content height (119 / 91 / 151 vs the 147 three-line loading card). y is still compared for every
   occurrence: a part below exempt parts in the same scrolling region (`scroller` = nearest clipping
   ancestor) is compared after subtracting the exempt parts' height difference (outermost box counted once);
   the action row, status bar and composer, outside that region, are compared as they are.
   `VARIABLE_WIDTH` also a record: title, page-header-title, page-header-description, and
   page-header-actions (right edge compared via `RIGHT_ALIGNED`: a placeholder is 72 px, a real button is its
   label's width).
3. Width exemption built with `filter`, no `splice`.

## Newly found gaps and resolution
- No defect in a loading state came out of the presence check: every missing loaded part is either real data
  (title text, buttons, form controls, validation, unsaved/error counts, table rows/cells, thread turns, file
  preview content) that the loading state replaces with placeholders under another name, or it paired through
  an alias. Each is listed with its reason in `DATA_ONLY_PARTS`.
- Position artifacts of the first draft (sidebar and bottom-anchored parts shifted by exempt heights) were
  bugs of the spec, fixed by the same-scroller and containment rules above.
- Loaded vs loading card heights and header actions width differ by design (exempted with reasons).

## Runs
- Exploratory runs (dark only) listed the gaps above; all resolved as described.
- Green: `CAPYBARA_VISUAL_PORT=3199 pnpm exec playwright test -c playwright.chrome.config.ts skeleton-alignment fidelity.spec.ts`
  -> 132 passed, 2 failed (the pre-existing sidebar `at=inbox` force selector, both themes, same at 10ec3ebe).
  Skeleton alignment: all 20 passed.
- Red A (Detail: loading cards removed, uncommitted): dark and light template-detail fail with
  `detail loading: card appears 0x while loading, 2x loaded`; the other 18 pass.
- Red B (Detail: loading inspector removed): fails with `key-value appears 0x while loading, 1x loaded`,
  `key-value-row appears 0x while loading, 4x loaded` plus the layout shifts of the now single-column page.
- Limit: a removed region whose loaded counterpart has no `data-part` or is data-only (the header buttons'
  count, form controls) is still seen only through box shifts.

# Fix round 2

Commits: "placeholder counts pair with the loaded parts they stand in for", "placeholders pair through their
ancestor; fields are compared by count", "button boxes are compared in y and height; the auth submit pairs its
box" (see `git log`). Same method; temp worktree and branch removed.

## Changes
1. Placeholder counts are now compared. `LOADING_ALIASES` gains `loading-field` = `field`, `loading-bubble` =
   `bubble`, and ancestor-qualified keys `<ancestor part> > <part>` for boxes whose own part is the generic
   `skeleton-box`: `page-header-action-slots > skeleton-box` = `button`, `loading-switch-row > skeleton-box` =
   `switch`, `card > skeleton-box` = `button` (the auth submit box). Loaded `Field` now carries
   `data-part="field"`; the thread's loading user bubble slot carries `data-part="loading-bubble"`.
   Global data-only is cut to the form controls counted through `field` (input, input-control, textarea,
   select, segmented, segment), field-label, switch-knob, field-error and the action row's unsaved/error
   counts. `button`, `switch`, `bubble`, `row` and `cell` are no longer global: `row`/`cell` are data-only only
   on the inbox records pair, and the conversation's file-panel parts (button, prose, markdown, tool-line,
   file-card, file-name, type-badge, panel-meta, preview-table*) only on the conversation pair. The action
   row's real Save/Cancel and title-bar buttons are counted.
   Box rules for the newly paired parts: `button` is compared in y and height only (`HEIGHT_ONLY`: its width
   is its label; slots are 72 px); `bubble` has `VARIABLE_WIDTH` and is right-aligned; `field` is
   `COUNT_ONLY` (loaded fields differ in height by control/help text and two share a row in the fixture).
2. `form-section-head` is out of `VARIABLE_HEIGHT`. `FOLLOWS_HEIGHT` compares it with the loading
   form-section's height of the same index (it is the stretched grid cell), and its y gets the form-section
   shift like everything else. `form-section` and `form-card` stay: their reason (help text, paired and tall
   controls in the fixture) holds.
3. Spec: Detail's loading card size row `loading-card | loading | height | 147`, and the Detail loading
   paragraph says why (1 px border x 2, head band 37, body 108). fidelity measures it (passes).

## Runs
- Green: `CAPYBARA_VISUAL_PORT=3199 pnpm exec playwright test -c playwright.chrome.config.ts skeleton-alignment
  fidelity.spec.ts` -> 132 passed, 2 failed (pre-existing sidebar `at=inbox`, both themes); all 20 skeleton
  cases pass.
- Red, one loading field dropped (`LoadingFields` count - 1): form, settings, wizard, auth fail, e.g.
  `form loading: field appears 3x while loading, 5x loaded`.
- Red, one header action slot dropped: detail `button appears 1x while loading, 2x loaded`; overview, inbox (both
  pairs), trace `button appears 0x while loading, 1x loaded`.
- Red, one switch row dropped: form `switch-row appears 3x while loading, 4x loaded` and `switch appears 3x ...`.

## Notes
- The first run of this round showed the real boxes of the newly paired parts: loaded fields are 72 / 74 / 134
  px against the 52 px placeholder and the fixture pairs two fields in a row, hence `COUNT_ONLY` for `field`
  (a limit: field boxes are not measured against the loaded ones; the control-height box inside a field is
  covered by the `skeleton-box[data-box=default]` size row).
- Still count-blind: loaded control kinds (input, select...) are counted only through `field`.

# Fix round 3

Commit: 2bfe1b22 `feat(design): loading fields take the page's static field shapes`. Same method; temp worktree
and branch removed.

## Changes
- `FieldShape = { control?: "input" | "textarea" | "select" | "segmented"; help?: boolean; rows?: number;
  pair?: boolean }`, exported from the design package. `FormSection.loading.fields`, `WizardPage.loading.fields`,
  `AuthPage.loading.fields` and `SettingsPage.loading.sections[].fields` take `number | FieldShape[]` (a number
  is N default inputs, unchanged).
- `LoadingFields({ fields })` (frame.tsx): per shape the loaded `.cb-field` markup with a label slot, the
  control box (input, select, segmented = `control.default`; textarea = new `SkeletonBox part="textarea"
  rows`, CSS `max(rows, 2) * body line + space.2 + 2 px`), a `small` slot when `help` (help, error or counter
  line), and the loaded section's own `Grid columns=2 gap=12` for a `pair` shape plus the next one.
- Fixture: `loadingShapes()` in apps/web/src/dev/catalog/reference-blocks.tsx builds the shapes from the same
  fixture the loaded form draws (control kinds, error / counter help, textarea rows 2 / 4, the paired first two).
  The wizard, settings and auth fixtures have plain inputs, so their numbers stay.
- Spec: §5.3 (prop, shape, "the page must pass its static layout whenever a field is not a plain input",
  textarea height rule, help slot, pair grid), §5.8 / §5.9 / §5.10 (`count or FieldShape[]`), and a size row
  `skeleton-box[data-box=textarea] | loading | height | 50` in the Form table.
- accepted.ts: `COUNT_ONLY` (field) removed, `form-section` and `form-card` removed from `VARIABLE_HEIGHT`, and
  `FOLLOWS_HEIGHT` removed (form-section-head now compared directly). Remaining `VARIABLE_HEIGHT`: content,
  thread, table, card, each with its reason. `field` is compared in x, y, width and height.
- Unit tests (templates-loading.test.tsx): textarea shape draws the textarea box with its rows; help draws one
  small slot and only then; pair draws the two-column grid with the next field and the third stays outside; a
  number still draws default inputs, and AuthPage takes shapes.

## Runs (temp worktree, Chrome channel override, port 3199)
- Green: `skeleton-alignment fidelity.spec.ts` -> 132 passed, 2 failed (pre-existing sidebar `at=inbox`, both
  themes). All 20 skeleton cases and the textarea size row (50 px) pass, so the fields now match the loaded
  72 / 74 / 134 px and the paired row exactly.
- Red 1: dropped the input's error `help` from the fixture shape -> `form loading field#0 height: loaded 72,
  loading 52`, `form-section#0 height: loaded 190, loading 170`, and the y shifts below it.
- Red 2: textarea rows 4 -> 2 in the fixture -> `field#4 height: loaded 134, loading 94`,
  `form-section#1 height: loaded 230, loading 190`.
- `pnpm exec vitest run packages/design/test apps/web/test`: 2313 passed. `pnpm check`: all checks passed.
  `pnpm typecheck`: exit 0. `pnpm exec biome check .`: no errors (14 warnings and 1 info are existing).
  Run in the temp worktree.

## Notes
- No real app page passes `loading.fields` yet (the apps/web pages arrive in later tasks); they must pass
  their shapes by the spec rule.
- By mistake `pnpm typecheck` was first run once in this worktree; its `next typegen` only regenerates route
  types in `apps/web/.next/types` (no build, no server). Everything after ran in the temp worktree.
