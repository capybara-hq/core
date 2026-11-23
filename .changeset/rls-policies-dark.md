---
"@capybara-hq/kernel": minor
---

RLS phase 3 (issue #115): migration 0181 enables and forces row level security on every kernel
table with an `org_id` column, with one policy per table through `capybara.rls_admits`. The
policies admit every row unless the kernel pool enforces them (`db.rls: enforce`). On a database
role that is subject to RLS (not a superuser, no BYPASSRLS; the compose file's role is a superuser)
`pg_dump` then needs `--enable-row-security` and `COPY FROM` into these tables is refused; see
"Row level security" in docs/deploy/README.md. With `enforce`, the kernel logs an error at start when its database role is a
superuser or has BYPASSRLS, since PostgreSQL never applies RLS to such a role.
