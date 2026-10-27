---
"@capybara-hq/web": patch
---

The web conversation page shows sub-agents (interim, until UI refresh B): one group per step of
`agent` calls with status, calls and duration, a read-only sub-agent view in the Inspector with
stop (`?subagent=<id>` opens one), a sub-agent's approvals and questions in the parent, and the
total tokens with sub-agents in the Context tab; trajectories link agent calls and parents both ways.

The agent page has a Sub-agents section (the agent tool, general-purpose, plugin templates from the
new `GET /agent-templates`, inline templates, allowlisted org agents with their warnings, and
"Can be used as a sub-agent by other agents"); the import review and catalog item list agent
templates; the purposes page explains the three sub-agent tiers; the admin console sets
per-organization sub-agent limits.

A sub-agent opened from the address bar must belong to the conversation; a sub-agent's question for
someone else shows who it waits for; the plugin upgrade dialog lists agent template changes and an
organization's catalog item lists the plugin's agent templates.
