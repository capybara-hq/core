---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/testing": patch
"@capybara-hq/plugin-tools": patch
---

Add personal inbox items (collaboration spec §4.9). Extensions with `permissions.inbox` post
items for one member with `ctx.inbox.post` (title, body, a link to their own `/p/<plugin>/` pages,
up to three buttons naming their UI actions, an expiry, an optional dedupe key) and close them with
`ctx.inbox.resolve`. The kernel stores them in `inbox_items` (migration 0190), lists them in the
person's inbox only, calls a button's UI action as the person who clicks
(`POST /orgs/:orgId/inbox/items/:id/actions/:actionId`) and resolves the item, or dismisses it
(`POST …/dismiss`, also the Platform operation `inbox.item-dismiss`). New items push under the new
category `inbox`. A trigger event stopped at the chain depth now posts a kernel item to the owner
of the chain's last automation. The review shows `permissions.inbox` (blocking, not sensitive),
`capybara-plugin check` reports `perm-inbox`, and the `fake-trigger-source` fixture gains
`ctx.inbox` and an `org.page` view with a recording UI action.

`ctx.triggers.causeOf(call)` returns a handle (24 hours, bound to the call's org and run and to the
extension; table `trigger_cause_handles`, migration 0191) that a `ctx.queue` job passes as
`emit({ cause: { handle } })`, so a queued event keeps the call's chain depth and self-trigger
check. The trigger event sweep no longer flushes a window the dispatcher just opened, backs off
re-owing a lost window and gives up after a day, deletes expired handles, and deletes inbox items
closed or past their expiry more than `inbox.retentionDays` (new platform config, default 30) ago.

`ctx.agents.usableBy`, `ctx.conversations.bySubject` and `ctx.people.get / search` give pages
read-only org facts, each behind its own permission (`permissions.agents: { read: true }`,
`permissions.conversations: { subjects: true }`, `permissions.people: { read: true }`; blocking,
not sensitive). `usableBy` lists the agents an active member may use; `bySubject` returns the
metadata (state from the latest run, never content) of the live conversations of the extension's
own subjects; `people` returns members' names and avatars (at most 200 ids per `get`, `search`
limit 50), never email. A call needs the extension enabled in the org (`CtxReadError`
`org_disabled`). `capybara-plugin check` reports `perm-agents`, `perm-conversations` and
`perm-people`.
