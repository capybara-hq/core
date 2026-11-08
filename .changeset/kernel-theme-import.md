---
"@capybara-hq/kernel": minor
---

Plugin import, sync, update and removal carry themes: a plugin's `themes/*.json` (or
`manifest.themes`) are parsed, readability-checked and their fonts and logos validated at import
(refusals `theme.invalid` / `theme.unreadable`), synced as platform theme components with their
sanitized assets under `deployment/platform/themes/<id>/<version>-<catalogVersion>/`, updated with
their plugin and removed with it. Themes-only org uploads pass the custom content gate.
A stored theme version holds only the theme file's own values (merged with the built-in tokens
where they are used), and a catalog version is not judged for readability again on update or
rollback, so a core token change neither blocks nor re-versions existing themes.
