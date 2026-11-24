---
"@capybara-hq/kernel": minor
---

RLS phase 3 (issue #115): migration 0182 creates `capybara.rls_admits` and one row level security
policy per kernel table with an `org_id` column, truly dark: no table enables RLS yet (a later
migration does), so nothing changes for any database role. With `db.rls: enforce` the kernel logs
an error at start while RLS is not enabled on the tables or its role is a superuser or has
BYPASSRLS, since PostgreSQL filters nothing then.
