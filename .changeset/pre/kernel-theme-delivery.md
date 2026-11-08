---
"@capybara-hq/kernel": minor
---

Serve themes: the public, immutable `GET /api/v1/themes/:id/:version/theme.css` (rendered from the
stored theme, every value re-validated) and `…/assets/:file`, and the public
`GET /api/v1/platform/theme`; new error code `theme.not_found`.
