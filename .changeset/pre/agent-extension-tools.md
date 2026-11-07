---
"@capybara-hq/web": patch
"@capybara-hq/kernel": minor
---

Agents can select extension tools: the agent page's Tools section lists the tools of the extensions
enabled in the org (new `GET /api/v1/orgs/:orgId/tools/extensions`) and adds or removes their
references; a selected tool that is unavailable stays listed as unavailable with the reason.
