---
"@capybara-hq/kernel": patch
---

Add `GET /api/v1/orgs/:orgId/agents/:agentId/mentionable-connectors`: the connectors the web input
box's `@` menu offers for an agent (live, active connectors the agent has tools of, plus the
`needs_config` ones), with the caller's credential state; it opens no connector session.
