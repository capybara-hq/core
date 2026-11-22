---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Responsive system, system pieces (#605): `ClassForms` / `useClassForm` render a structure per size
class (both on the server, CSS shows one, only the matching one stays mounted after hydration);
the `ActionSheet` uses the native `menu@1` sheet on compact when it holds no links; card grids are
one grouped list of rows below 600 (no buttons, long press or right click opens the card's actions);
DataTable columns may declare `compact` roles (title, subtitle, meta, trailing, hidden) and are
then drawn as grouped rows below 600; `Tabs look="segmented-compact"`; `ShellPage.actions` and
`titleAway` with the centred scrolled title, and `useCompactScroll` for one-scroller pages. New
checks keep size-class reads out of pages, view choices out of `ListPage.filters`, template-only
props in templates and dual renders in `ClassForms`.
