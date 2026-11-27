---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/plugin-tools": patch
---

Component queries for plugin pages: `POST /api/v1/orgs/:orgId/ui/query/:plugin/:id` runs a
component's `ctx.ui.query` handler (params ≤ 16 KB, result ≤ 1 MB, 10 s timeout); component
actions take payloads up to 64 KB and may name queries to refetch; `ctx.ui.invalidate` carries
`queries: true`. The `fake-client-page` test fixture; `perm-ui` checks `ctx.ui.query` ids.
