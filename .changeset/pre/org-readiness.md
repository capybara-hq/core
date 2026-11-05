---
"@capybara-hq/kernel": patch
---

`GET /api/v1/orgs/:orgId/readiness` tells whether an organization can run: `modelProvider` is `ready` when a model-provider extension is loaded (from extension state, never a vendor call) and `agents` counts the agents the caller can see. The web app decides between the shell and the guided setup layout with it.
