---
"@capybara-hq/kernel": minor
---

A theme's stylesheet is one `@layer theme { … }` block, in the layer order the design stylesheet
declares (design, theme, extensions). Its URL carries a render revision,
`/api/v1/themes/<id>/<version>/r<n>/theme.css` (`THEME_CSS_REVISION`, now 2, bumped whenever the
output format changes): only the current revision is served (404 `theme.not_found` otherwise) and
the old URL without a revision is gone, so no browser keeps an older format cached as immutable.
