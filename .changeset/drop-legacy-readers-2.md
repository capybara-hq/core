---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

More release-candidate compatibility removed before 0.1.0: the deprecated
`POST /api/v1/orgs/:orgId/conversations/:id/queue` alias is gone (send with `…/messages`).
