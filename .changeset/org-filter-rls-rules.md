---
"@capybara-hq/kernel": patch
---

RLS (issue #115): queries marked deployment-wide run in the platform scope (`asPlatform`), and
`check:org-filter` requires that and an RLS policy for every org-scoped table. No behaviour change
while `db.rls` is `off`.
