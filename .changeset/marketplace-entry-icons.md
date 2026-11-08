---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Marketplace rows show icons: an imported plugin its catalog icon, otherwise the icon its
marketplace entry names. The kernel downloads entry icons on refresh through the marketplace
network rules (or reads them from a git marketplace's commit), keeps real svg / png files of at
most 64 KiB in PG (migration 0099) and serves them to super admins on
`GET /api/v1/admin/marketplaces/:id/icons/:sha256`; the admin entries carry `icon`. A bad icon never
fails the refresh.
