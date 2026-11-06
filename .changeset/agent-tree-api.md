---
"@capybara-hq/kernel": minor
---

`GET /api/v1/orgs/:orgId/conversations/:id/agent-tree` returns a root conversation's agent tree (each
node's status, model, time, tokens, tool calls and children; owner only), and `subagent_progress` now
reaches the stream of every ancestor of the progressing sub-agent.
