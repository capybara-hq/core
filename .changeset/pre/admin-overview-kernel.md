---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Admin overview reads for super admins: `GET /admin/overview` now answers
`{ orgs, accounts, attentionTotal }`, `GET /admin/inbox` adds `byType`, and the new
`GET /admin/overview/attention` and `GET /admin/audit` (platform-level audit log, migration 0109)
come with the read-only Platform operations `admin.attention` and `admin.audit`
