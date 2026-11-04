---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

Kernel: an org chooses the default provider of an `org-default` extension point (`web-search`,
`web-fetch`): table `org_extension_point_defaults` (migration 0064), `ExtensionPointDefaults`
(`resolve`, `list`, `setDefault`) and the routes `GET /api/v1/orgs/:orgId/extension-points`,
`PUT …/extension-points/:point/default` and `GET …/extension-points/available`. Testing: the fake
extensions `fake-web` and `fake-web-2` (scripted `web-search@1` / `web-fetch@1` providers).
