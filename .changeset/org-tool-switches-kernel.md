---
"@capybara-hq/kernel": patch
---

Org admins turn off single extension tools (`GET` / `PUT /api/v1/orgs/:orgId/extensions/:extension/tools[/:tool]`):
switching off is previewed with the org's agents that selected the tool and confirmed with its
hash; a turned-off tool is unavailable to every agent of the org, refused if called, and marked
`switchedOff` in the agent editor's tool list. Audit `extension.tool_switched`.
