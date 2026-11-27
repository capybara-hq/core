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
