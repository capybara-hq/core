---
"@capybara-hq/web": patch
---

The web conversation page shows sub-agents (UI refresh B's components): the `agent` calls of a step
as one sub-agent group with status, calls and duration (live from `subagent_progress`), a row that
opens the child read-only in the right panel (`#subagent=<id>`; inbox and IM links with
`?subagent=<id>` open it too) with its task, its own thread, Stop and a read-only status bar, a
sub-agent's approvals and questions in the parent under its name (only the conversation's starter
can act), a Background tasks section in the properties panel, and the total tokens with sub-agents
in the Context section; trajectories link agent calls and parents both ways.

The agent page has a Sub-agents section (the agent tool, general-purpose, plugin templates from the
new `GET /agent-templates`, inline templates, allowlisted org agents with their warnings, and
"Can be used as a sub-agent by other agents"); the import review and catalog item list agent
templates; the purposes page explains the three sub-agent tiers; the admin console sets
per-organization sub-agent limits.

A sub-agent opened from the address bar must belong to the conversation; a sub-agent's question for
someone else shows who it waits for; the plugin upgrade dialog lists agent template changes and an
organization's catalog item lists the plugin's agent templates.
