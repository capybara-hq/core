---
"@capybara-hq/capybara": patch
---

Connector templates and the connectors made from them show the template's own icon (for example
Gmail, Drive and Calendar of one Google plugin) instead of their plugin's icon; a template without
an icon of its own still shows its plugin's. New routes serve the icons:
`GET /api/v1/orgs/:orgId/connector-templates/:templateId/icon` and
`GET /api/v1/admin/catalog/connector-templates/:templateId/icon`.
