---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

`GET /orgs/:orgId/conversations/groups` gives each group's agent its avatar and profile time
(`agent.profile: { avatar, updatedAt }`, the agents API's shape), and the sidebar draws the group
titles from it: the agent's pixel avatar or image shows on every page, not only when the agents
list happens to be cached; an agent without an avatar still shows its initial.
