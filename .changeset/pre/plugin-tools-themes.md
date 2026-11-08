---
"@capybara-hq/plugin-tools": minor
---

`capybara-plugin pack` ships a plugin's themes (`themes/*.json` or `manifest.themes`) with the fonts
and logos they reference, and a plugin may hold only themes. `capybara-plugin check` adds the
"Themes" check: `theme-invalid`, `theme-readability` and `theme-asset` (the 16 MB asset limit is
summed over the plugin's themes).
