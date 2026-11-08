---
"@capybara-hq/kernel": minor
---

Which theme applies: the platform default (`uiTheme` in the deployment settings, a platform theme
whose scope is `all`), the org default and personal lock (`theme` in the org settings) and the
person's pick (`theme` in `PUT /api/v1/me/preferences`, which is now a partial update) are checked
where they are set (`theme.not_available`). `GET /api/v1/orgs/:orgId/themes` lists the themes on in
the org with swatches, the viewer's resolved theme and the org's setting; the Platform tool gains
`themes.list` and the theme fields in its settings operations.
