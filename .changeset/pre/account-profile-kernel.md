---
"@capybara-hq/kernel": patch
---

A person edits their own name and avatar (`PATCH /api/v1/me/profile`, presigned avatar uploads);
every response that shows a person carries their avatar URL, served by a guarded
`GET /api/v1/accounts/:id/avatar`.
