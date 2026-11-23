---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Connector templates and the connectors made from them show the template's own icon (for example
Gmail, Drive and Calendar of one Google plugin) instead of their plugin's icon; a template without
an icon of its own still shows its plugin's. The plugin install wizard lists the connector
templates with their icons. A connector's icon is served on its own route, so guests, who see the
connector pages but not the catalog, can load it too. New routes:
`GET /api/v1/orgs/:orgId/connector-templates/:templateId/icon`,
`GET /api/v1/admin/catalog/connector-templates/:templateId/icon` and
`GET /api/v1/orgs/:orgId/connectors/:connectorId/icon`.
