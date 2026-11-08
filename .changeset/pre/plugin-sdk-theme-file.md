---
"@capybara-hq/plugin-sdk": minor
---

Theme file format: `parseThemeFile`, `ThemeFileSchema`, `THEME_LIMITS`, `themeIdOf` and the
`themes` field of `plugin.json` (a plugin may consist of themes only).
A parsed theme holds only the file's own values; `mergeThemeSchemes` merges it onto the current
built-in tokens (skipping overrides the built-ins no longer know), and
`parseThemeFile(id, json, { readability: false })` re-reads a version already in a catalog without
judging its readability again.
