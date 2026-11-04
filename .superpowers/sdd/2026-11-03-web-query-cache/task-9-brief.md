### Tasks 7–9: Template loading states

All three tasks follow the same flow, per template:

1. A failing render test in `packages/design/test/templates-loading.test.tsx`: `"<Template> loading draws the frame and no children"`, plus the cases listed below.
2. The `loading` prop.
3. A spec §5 state list `loading`, and a size-table row per skeleton part, with the same values as the loaded parts.
4. A `<template>-loading` block in `docs/design/reference/src/template-<name>.html`.
5. The `/dev/ui/reference/template-<name>` blocks `loading` and `default`, built from the same fixture so the boxes can be compared.
6. Add `template-<name>` to `apps/web/visual/accepted.ts`.
7. Pass `pnpm exec vitest run packages/design/test`.
8. Commit `feat(design): <template> loading state`.

Shape rule for every template (spec §7.1): every region of the loaded page keeps its box.
- Text becomes `SkeletonText`, and controls become `SkeletonBox` of their control height.
- A repeat count the page passes in is used as given. Otherwise it is the template's default, which is written in its spec section.
- A region whose content is passed in for real (`children` with data) renders for real. Only regions flagged as loading become skeletons.

**Task 9: `ConversationPage`, `TracePage`, `ListPage` check**
- `ConversationPage`:
  - `loading?: { thread?: boolean; title?: boolean; rightArea?: boolean }`.
  - The thread skeleton is three turns: a user bubble bar right-aligned at 45%, then two prose bars at 100% and 70%, all in the thread width.
  - The composer always renders for real, disabled while `thread` is loading.
  - The title bar has a title bar at 30% and real icons.
  - A right panel whose data is missing draws its own panel skeleton, which already exists in §6.16 (`loading` state); reuse it.
  - Extra test: `"composer keeps its box while the thread loads"`.
- `TracePage.loading?: { spans?: number }`: stats slots, then `spans` waterfall rows (default 6) at the row height. The detail panel is a skeleton.
- `ListPage`: check the existing `loading` against the shape rule, including the header tabs' "–" counts. Change it only if a box differs, and add a test `"list loading boxes equal loaded boxes"`. The same check runs in Task 9b.

