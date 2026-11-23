---
"@capybara-hq/kernel": minor
---

RLS phase 3 (issue #115): migration 0181 enables and forces row level security on every kernel
table with an `org_id` column, with one policy per table through `capybara.rls_admits`. The
policies admit every row unless the kernel pool enforces them (`db.rls: enforce`), so nothing
changes by default. With `enforce`, the kernel logs an error at start when its database role is a
superuser or has BYPASSRLS, since PostgreSQL never applies RLS to such a role.
