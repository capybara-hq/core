# Task 8 report: FormPage/FormSection, SettingsPage, WizardPage, AuthPage loading states

Commit: 0c2bc36b `feat(design): form, settings, wizard and auth loading states` (one commit, not pushed).

## Props
- `FormPage.loading?: boolean`: header via `loadingHeader`, one `SkeletonGroup`, ActionRow stays (buttons disabled, no unsaved/error count). `children` render as given (sections carry their own loading). The `create` autofocus effect now waits for `loading` to end.
- `FormSection.loading?: { fields }`: title and description real; `fields` placeholders in `.cb-form-section-fields`. Outside a group it announces itself (aria-busy + hidden text, no role).
- `SettingsPage.loading?: { sections?: { fields; title?; description? }[] }`: header loading, sub-nav and header description real, ActionRow disabled. With `sections`: placeholders replace children (`LoadingFormSection`, internal); without: children render (their own loading).
- `WizardPage.loading?: { fields }`: step bar real; body is one real `Card` (30% title slot) with a `Stack gap=16` of fields; ActionRow disabled.
- `AuthPage.loading?: { fields }`: frame, dither, logo, card, subtitle, footer, preferences stay; empty title is a title bar; card body = fields + a `prominent` SkeletonBox (the submit button, matching the real login's Stack gap 16).
- Shared in `frame.tsx`: `LoadingFields` (a real `.cb-field` per field: label slot in `.cb-field-head`, then `SkeletonBox default` directly in the field, no width of its own, so the field's rule decides) and `loadingActionRow`.
- Additive API: `ActionRowProps.cancel.disabled`; `SkeletonText size="heading"` (h2 line, 24px) for an unknown section title; `data-part="auth-card"` on the auth card.

## TDD
RED: with `packages/design/src` reverted to HEAD, `templates-loading.test.tsx` gave 12 failed | 16 passed. GREEN: 28 passed. Each page test asserts exactly one `role=status`.
Final: `vitest run packages/design/test apps/web/test/catalog.test.tsx`: 48 files, 904 passed. `pnpm check` all passed, `pnpm typecheck` clean, biome clean (2 pre-existing CSS specificity warnings).

## Spec / docs
spec.md: §5.3 loading text, state list `page, loading` and size rows for template-form; new §5.8 Settings, §5.9 Wizard, §5.10 Auth with states `default, loading` and size tables. Reference sources: `template-form.html` (+ `template-form-loading`, fill.js `form-page` option `loading`), new `template-settings/wizard/auth.html`, reference.css, index.html. /dev/ui: `template-form-loading` in reference-blocks.tsx (same FormTemplateBody fixture), `-default`/`-loading` blocks for settings/wizard/auth in template-loading-blocks.tsx. Registered in accepted.ts, routes.tsx, render.spec.ts, review-page.mjs.

## Self-review / concerns
- Reference auth HTML draws the dither columns empty (not the dot matrix); the /dev/ui block has the real Dither.
- A `flush` FormSection (SwitchList) loads on the padded card (data-flush dropped while loading).
- Added `.cb-ref-block .cb-auth { height:100%; min-height:0 }` so AuthPage fills a reference block instead of 100vh.
- Also added missing `.r-skel-text[data-size=metric]` height in reference.css (Task 7's overview reference used it without a rule).
- Size-row values `settings-nav width 200` and `auth-card width 400` are literals; Playwright (fidelity, reference render) not run (Task 9b). Reference PNGs wait for reference-update.
- Pages in apps/web are unchanged; no existing caller's behaviour changes (all new props optional).

## Fix round 1
Commit: `fix(design): a flush section keeps its flush card while loading`. A loading `flush` FormSection keeps `data-flush="true"` and draws `LoadingSwitchRows` (frame.tsx): SwitchList's own `ul.cb-switch-list` / `li.cb-switch-row` (divider, padding, row.roomy), a body name slot over a small description slot in `.cb-switch-row-text`, and a 32x20 SkeletonBox for the switch. One row per `fields`. Spec §5.3 deviation sentence replaced by the flush rule; size row `loading-switch-row | loading | height | row.roomy`. /dev/ui loading passes the switch row count for the flush section; both `-page` and `-loading` blocks already include it from the one fixture; fill.js reference draws the same. New test checks data-flush, the row classes and one role=status. Vitest 905 passed, check, typecheck, biome clean.
Note: the size-table value for the new row is checked by Playwright (not run).
