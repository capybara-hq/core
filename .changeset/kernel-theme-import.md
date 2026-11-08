---
"@capybara-hq/kernel": minor
---

Plugin import, sync, update and removal carry themes: a plugin's `themes/*.json` (or
`manifest.themes`) are parsed, readability-checked and their fonts and logos validated at import
(refusals `theme.invalid` / `theme.unreadable`), synced as platform theme components with their
sanitized assets under `deployment/platform/themes/<id>/<version>-<catalogVersion>/`, updated with
their plugin and removed with it. Themes-only org uploads pass the custom content gate.
