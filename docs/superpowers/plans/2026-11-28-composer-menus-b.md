# Composer menus, Phase B: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development layered with
> wave-planned-subagent-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** finish the composer menus spec (`docs/superpowers/specs/2026-11-28-composer-menus-design.md`)
now that the layered shell (#979) and the file library (#1010) are on main: the composer's top strip
and control row (§6, §7), the `@` files group (§4) and 文件库 in ＋ (§2).

**Architecture:** the design package gets the composer layout (a top strip slot above the textarea, a
reordered control row, the medium and compact forms, the compact device / project sheet); the web
splits the device picker's project group into its own picker and fills the strip, reads the library
search for `@`, and adds library files to the draft as ready files (no upload, never discarded).

**Tech stack:** React 19, `@capybara-hq/design`, Next app router, TanStack Query, vitest + jsdom,
Playwright (compare, fidelity, visual).

Phase A shipped in PR #1000 (plan `2026-11-28-composer-menus.md`).

## Facts (origin/main 883fc9752)

- `ComposerBox` (`packages/design/src/conversation/composer.tsx`): control row today ＋ · agent ·
  `composer-pickers` (device, model · effort when `mode` is given) · `ComposerOptions` (phones) ·
  quick actions · agents chip · grow · mode · suggestion use; send and the context meter sit with the
  textarea (the touch pill `composer.box`). Below 600 device / model / effort are one
  `ComposerOptions` sheet.
- The project is chosen inside the device picker (`useDeviceChoice` in
  `apps/web/src/components/conversation/useSelection.ts`: a 项目 group of 自由模式 + the device's
  projects; the value reads `<device> · <project>`). An existing conversation passes a `locked`
  device picker; its project comes from `conv.conversation.project`.
- `libraryFileSearchQuery(orgId, q)` (`apps/web/src/lib/query/library.ts`) reads
  `GET /orgs/:orgId/files?q=&limit=8` (`LibraryFileView`: id, name, size, type, origin, …).
- Draft files (`apps/web/src/components/use-draft-files.ts`): `DraftFile { key, name, size, status,
  progress, id?, error?, file? }`; removing one discards the kernel draft (`discardDraft`).
- ComposerBar `MenuState.scope`: `"resources" | { connectorId }`; the ＋ menu has a comment where 文件库
  joins.

## Tasks

### Task B1 (design): composer top strip, control row, size classes

**Files:** `packages/design/src/conversation/composer.tsx`, `composer-options.tsx` (or a new
`composer-place.tsx` for the compact device / project sheet), the composer CSS, design i18n,
`docs/design/spec.md` §6.16.2 (layout text, states, size table), `docs/design/reference/src`
(composer blocks: `composer-strip`, `composer-strip-locked`, `composer-medium`, `composer-compact`
or the existing compact blocks updated), `apps/web/src/dev/catalog/*` (reference blocks), design
tests.

**Interfaces (produces):**
```ts
type ComposerBoxProps = {
  // …existing…
  /** The top strip (§6.16.2): device then project; locked = static text. */
  place?: { device: PickerProps; project?: PickerProps };
};
```
- Expanded: strip `device / project` in full above the textarea; control row left ＋ · mode (label),
  right model · effort · context meter · send (quick actions and the agents chip stay at the left
  after mode).
- Medium (600–840): mode icon only with its tooltip; the project truncates first.
- Compact: the strip is one picker 「<device> / <project>」 opening a bottom sheet (device group, then
  that device's projects); ＋ and mode `touch.hit` icon buttons; the model shows its name only, the
  effort moves into the model sheet; `ComposerOptions` no longer carries the device.
- The touch pill and every existing state keep working; the reference set and spec change first.

### Task B2 (web): `@` files group and 文件库 in ＋

**Files:** `apps/web/src/components/conversation/ComposerBar.tsx`,
`apps/web/src/components/use-draft-files.ts`, messages zh / en, `apps/web/test/composer-menus.test.tsx`
(+ the use-draft-files test).

- `@` opens with groups 最近文件 (empty query) / 匹配的文件 (query) from
  `libraryFileSearchQuery(orgId, q)` (debounced like resources, its own cache key), rows with the
  file-type mark (`mark: { text: <EXT> }` like the type badge), the date / origin as description; then
  the resource groups. Scope `"files"` shows files only, `"resources"` resources only.
- Picking a file adds a ready draft file `{ key, name, size, status: "ready", progress: 1, id,
  library: true }` (no upload); `library` files are never discarded on removal; the per-message
  count applies; a file already in the draft is not added twice.
- ＋ 添加: 文件库 (icon `folder-open` or the design's file icon) opens `@` scoped to files.
- Tests: the query is asked with `q`, picking puts the id into the send body's `files` with no
  upload or discard call, removal of a library file calls no discard, 文件库 opens the files scope,
  an error in the library read shows the menu's unavailable line and keeps resources.

### Task B3 (web): the strip wiring (after B1)

**Files:** `apps/web/src/components/conversation/useSelection.ts`, `ComposerBar.tsx` (props pass
through), `ConversationView.tsx` / the new conversation view, messages, tests.

- `useDeviceChoice` returns `device` and `project` pickers (the project picker: 自由模式 + the
  device's projects; absent when the device offers none); ComposerBox gets `place`.
- An existing conversation: `place` with both locked (the project from `conversation.project`).
- Tests: picking a project on the new conversation sends it as today; another device drops the pick;
  the locked strip shows on a conversation.

### Task B4 (controller): acceptance, baselines, PR

- Compare `composer`, `composer-menu` in the Linux Playwright image; blind review; fix severe /
  moderate; ACCEPTED (composer already accepted: keep, add new states to its state list).
- Changesets: `@capybara-hq/design`, `@capybara-hq/capybara`.
- `pnpm verify --fast`, `check:web-ui`, `check:i18n`, changed tests; merge origin/main; push; ready PR
  (Refs #973); `reference-update` then `visual-update`; `ci-ok` green.

## Wave plan

| Task | Depends on | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| B1 design layout | – | design composer, spec, reference, catalog | normal | 1 | batch W1 |
| B2 web @ files | – | ComposerBar menus, use-draft-files, messages | normal | 1 | batch W1 |
| B3 web strip | B1 | useSelection, ComposerBar props, views | normal | 2 | W2 |
| B4 acceptance | all | compare, accepted, changesets | – | 3 | controller |

B1 and B2 touch disjoint files (B2 does not touch `packages/design`; B1 does not touch apps/web
except the catalog).

## Progress

- 2026-11-28: plan written; wave 1 (B1, B2) dispatched.
