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

**Task 8: `FormPage` / `FormSection`, `SettingsPage`, `WizardPage`, `AuthPage`**
- `FormSection.loading?: { fields: number }`: the title and description stay real. Each field is a label `SkeletonText` 30% plus a `SkeletonBox` at the control height, in the same widths as the loaded field.
  - The page passes its static section list, so sections whose data is ready render for real.
- `FormPage.loading?: boolean`: the `ActionRow` stays with its buttons disabled.
  - Extra test: `"loading form keeps the action row with disabled buttons"`.
- `SettingsPage`: the sub-nav is always real. The content takes `FormSection` / `ListPage`-style loading from its children; no own prop beyond `loading?: { sections: { fields: number }[] }` for the common case.
- `WizardPage.loading?: { fields: number }`: the step bar is real.
- `AuthPage.loading?: { fields: number }`: the card frame and dither stay. The spec §7.1 list omits AuthPage, but its rule ("every template a page under `(auth)` uses") covers it.

