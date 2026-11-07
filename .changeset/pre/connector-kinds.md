---
"@capybara-hq/kernel": minor
"@capybara-hq/web": patch
---

`GET /api/v1/orgs/:orgId/connectors/kinds` lists the connector kinds whose extension is enabled in the org, with the plugin providing each. The connector install wizard offers only those kinds, and with none it points to Plugins instead of failing at the end.
