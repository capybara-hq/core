---
"@capybara-hq/kernel": minor
---

Agents have a profile (avatar, description, quick actions) stored outside the agent versions:
`profile` on the agent view, `PATCH /api/v1/orgs/:orgId/agents/:agentId/profile` with
`expectedUpdatedAt` (409 `agent.profile_conflict`), and a random preset avatar on create.
Avatars are a preset or an uploaded png, jpg or webp (`POST …/agents/:agentId/avatar/uploads`, at
most 2 MB), served by `GET …/agents/:agentId/avatar`.
