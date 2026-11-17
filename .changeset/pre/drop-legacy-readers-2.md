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
Migration 0141 deletes the plugin install ledger rows of org skills and agent templates without
plugin provenance (shared by the org as its own items, or its own rows an old install added a
version to; recorded before ruling P3-46); the uninstall no longer checks for promoted rows.
Log events no longer accept the shapes of older logs: `compaction_summary` requires `savedTokens`
and `step`, `compaction_failed` requires `step`, and `approval_requested` requires `requestedFor`
and `approverRole` (each nullable); the web reads `savedTokens` as always present.
Migration 0142 fills those fields on rows logged before they existed (`savedTokens` 0, `step` from
the run's compaction usage, the approver fields from the approval row).
