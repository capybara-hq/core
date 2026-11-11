---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Admin overview usage for super admins: the new `GET /admin/overview/usage?tz=` (with the read-only
Platform operation `admin.usage`) answers runs, tokens and estimated cost per calendar day in the
reader's zone over the last 7 days, and the 10 orgs that used the most tokens; cached 300 s for
every replica, 503 `admin.usage_unavailable` when the database takes over 10 s. Migration 0110
builds two plain indexes (`runs (created_at)`, `model_usage (occurred_at)`): on a large `runs`
table, writes to it wait while the index builds
