---
"@capybara-hq/kernel": patch
---

Complete the `Platform` tool's `setup` domain: `setup.guides` lists the setup guides a person may
help with (targets, drift, cached check counts, web pages) and mirrors the new
`GET /api/v1/orgs/:orgId/setup-guides` route; `setup.read` returns a guide rendered as Markdown
(checks as `- [check <id>]` lines) and mirrors the org guide route, which is no longer excluded.
Every setup operation is read class; secrets, OAuth consent and the guide ack stay human-only.
