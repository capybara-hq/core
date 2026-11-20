---
"@capybara-hq/plugin-sdk": patch
---

The built-in theme tokens gain `preview-light` and `preview-dark`, the two fixed grounds of the
app-icon preview (the same in both themes). They are not in `THEME_OVERRIDABLE`: a theme cannot
change them.
