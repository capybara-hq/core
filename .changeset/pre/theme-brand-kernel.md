---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Themes: the public asset route serves a theme's illustration, app icons and avatar files (only the
files the stored definition names), the catalog import stores them, and `ThemeRef` (theme listing,
platform default) carries `logo.illustrationUrl`, `logo.appIconUrl`, `logo.appIconMaskableUrl`,
`decoration` and `background` (the merged `bg` of each scheme the theme defines) (#451).
