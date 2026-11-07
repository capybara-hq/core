---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
"@capybara-hq/capybara": minor
---

Org members can read the org's 扩展 page: `GET /api/v1/orgs/:orgId/extensions` is the new action
`org.extensions.read` (member and up); a member gets each extension's state without its config, the
secrets' state, the config schema or the permission list, admins keep the full view. The page
hides every switch and config control for members.
