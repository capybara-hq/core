---
"@capybara-hq/kernel": minor
---

Themes are components with scope, org switches and previews: theme ids are unique among the
themes on in an org (`theme.id_taken`), previews of changes that take a theme away list the orgs
whose default it is and how many people picked it, and changes that would take the platform
default theme away from an org are refused (`theme.platform_default`).
