---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
---

RLS phase 2 (issue #115): the kernel carries an org scope from its entry points (org guard, super
admin routes, extension routes, jobs, cron ticks, run claims, channel and dial-in events, the start
sequence, CLI commands) and, with the new `db.rls` config (`off` by default, `scoped`, `enforce`),
sets it on every PostgreSQL connection. No behaviour change while `db.rls` is `off`.
