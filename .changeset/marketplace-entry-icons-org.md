---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

The workspace 插件 → 市场 tab shows plugin icons too: the org marketplace entries carry `icon`, the
item's org icon when the org sees the imported plugin, else the marketplace icon on
`GET /api/v1/orgs/:orgId/marketplaces/:id/icons/:sha256` (org admins, gated like the org browse).
