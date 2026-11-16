---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

More release-candidate compatibility removed before 0.1.0: the deprecated
`POST /api/v1/orgs/:orgId/conversations/:id/queue` alias is gone (send with `…/messages`).
Migration 0140 removes the history-only forms of agent definitions (an enabled `tools` list,
`skills.orgSkills` / `skills.pinned`) from agent versions, logged sub-agent definitions and eval
snapshots, fills both lists of every logged follow-up narrowing and drops `selectedSkills` from
agent template versions; the kernel no longer reads those forms. Saving an agent with a policy for
a builtin that no longer exists (`SkillWrite`) is now refused like any unknown key instead of being
dropped silently.
