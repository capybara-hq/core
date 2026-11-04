---
"@capybara-hq/kernel": patch
---

Agents have a profile (avatar, description, quick actions) stored outside the agent versions:
`profile` on the agent view, `PATCH /api/v1/orgs/:orgId/agents/:agentId/profile` with
`expectedUpdatedAt` (409 `agent.profile_conflict`), and a random preset avatar on create.
