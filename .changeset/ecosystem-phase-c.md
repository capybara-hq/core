---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
"@capybara-hq/plugin-tools": patch
---

Agents can dispatch sub-agents with the builtin `agent` tool; plugins can ship agent templates;
sandboxes run commands of parallel sub-agents concurrently.

The kernel shares a conversation's sandbox between up to `sandbox.maxConcurrentCommands` holders
(new, hot, default 6) under shared leases, keeps lifecycle changes exclusive, and kills only a
crashed holder's commands by their tag.

The Docker and E2B sandbox plugins declare concurrent exec: commands carry their holder's tag and
`killTagged` kills one holder's commands.

Rolling upgrade: finish it promptly. Older replicas don't read the per-holder records; new holders
also write the old busy marker (value `v2`), so an older replica that takes a sandbox after a new
holder crashed still kills the leftover commands. Anything that marker misses runs until the
in-sandbox time limit (`sandbox.limits.maxCommandSeconds`).

Agent definitions gain an optional `subagents` block (general-purpose, plugin and inline templates,
allowlisted org agents, `dispatchable`), checked on save (`agent.subagents_invalid`), and the
kernel declares the model purposes `subagent_fast`, `subagent_standard` and `subagent_capable`.

The builtin tool `agent` (always loaded under `tool_search`, default policy `allow`) lists the
agent's sub-agent roster in its description, with owner and plugin text made inert (one line per
entry, `<` / `>` shown as `‹` / `›`).

An `agent` call dispatches its sub-agent as a run of a read-only child conversation (messages to
it are refused with `conversation.read_only`, 409) on the new queue `cap-kernel-subagent-runs`;
the parent waits and gets the child's final reply as the tool result. Every dispatch is audited
`subagent.dispatched`. An empty roster offers no `agent` tool.

The wait sweep repairs sub-agent runs: a child whose enqueue was lost is enqueued again, a running
child without job or lock fails `run.orphaned`, the children of a finished parent are stopped, and
a parent whose resume was lost resumes once. A sub-agents wait timeout stops that step's children.
A child stopped outside its worker reports to its parent at once.

Sub-agent limits per parent run: `subagents.maxConcurrentPerRun` (4), `subagents.maxDispatchesPerRun`
(50) and `subagents.maxTokensPerRun` (5 000 000), all hot, with per-organization values in the
deployment setting `subagentLimitOverrides`; calls beyond them are refused with an actionable text,
and the `agent` tool description shows the organization's concurrency limit. Every child model
call (compaction included) adds its tokens to the parent run's counter; at the cap a running child
ends with `run_finished { reason: "budget" }`. A child stopped by its parent's sub-agents wait
timeout reports `timed out`, and a lost timeout job is recovered by the wait sweep through the new
`runs.wait_expires_at` (migration 0054).

Sub-agents' permissions and approvals: a child's policy is the parent agent's current version with
the frozen template overlay on top; its approvals and questions go to the person who started the
parent run, appear in the parent conversation as `subagent_waiting` (and as the usual cards in the
IM thread of a channel conversation, updated once the child is done), and link from the inbox to
the parent (`ApprovalView.parentConversationId`). "Approve for this conversation" on a child is
stored on the parent conversation. Hooks fire in sub-agents with `parent` set, `usage.report`
payloads of a sub-agent carry `parent`, and the parent's `agent` result is audited `tool.called`
and fires `tool.postExecute`.

Other org agents can be dispatched as sub-agents when the parent's owner allowlists them, they opt
in with `subagents.dispatchable`, and the person who started the conversation can use them; the
gates are checked at every dispatch and follow-up (a refusal is audited `subagent.refused`). Such
a sub-agent runs the agent's version frozen at its first dispatch, with the starter's personal
credentials, approvals and grants for that agent, and the parent's policies on top of its own.

Stopping a run stops its sub-agents: a parent stopped while it waits gets the stop text in its open
`agent` calls (audited and passed to `tool.postExecute`), every terminal state of a parent (its
deadline included) stops its active children, and removing a member stops their sub-agent runs too.

`GET /conversations/:id/subagents` lists a conversation's sub-agents (status, tool calls, usage,
pending approvals and questions), `GET /conversations/:id/usage` sums a conversation's usage with its
sub-agents', the conversation view gains `parentConversationId` and `subagentType`, a sub-agent's
sandbox status is its parent's, a child is opened through its parent conversation, and the parent's
stream carries an ephemeral `subagent_progress` message after each sub-agent step.

Plugins ship agent templates as `agents/<name>.md` (listed in `plugin.json` `agents` or scanned):
the packer ships and checks them, the import review lists them (`agentTemplates`, part of
`reviewHash` when there are any), and an org install creates one org template per plugin and name
(component `agent_template`, action `agents.manage`). Upgrades add a version to changed templates
and list them in the diff, rollbacks write the previous definition back, and uninstalling keeps a
template an agent selects (`used_by_agents`).

Claude Code plugins' `agents/*.md` are imported as agent templates (`<plugin>:<name>`): tools go
through the Claude tool-name table, model aliases map to tiers, and the report says what was
dropped or ignored (`agent_imported`, `agent_invalid`, `agent_tools_unmapped`,
`agent_model_mapped`, `agent_skills_truncated`, `agent_field_ignored`). The Claude Code tool-name
map now points `Task` / `Agent` at the `agent` tool when the agent has it; conversations get the
new map with their next skills snapshot. `capybara plugins import` prints agent templates.

Replay and evals cover sub-agents: a parent's full-run replay returns the recorded `agent` results
and starts no child; a sub-agent's run can be added as an eval case (under the parent's agent, or
the dispatched org agent), replays from its logged definition and preamble, and reports the new
drift reason `subagent_changed` when a candidate's effective definition differs; the trajectory
links each `agent` call to its sub-agent and back.

A translated Claude plugin whose agents all fail translation now imports with `agent_invalid`
items (raw `agents/*.md` files are never read as templates); `*` in an agent's tools and a pattern
in `disallowedTools` are reported (`agent_tools_inherited`, `agent_tools_narrowed`). The plugin
packer refuses duplicate agent template names and more than 64 scanned agent templates.

The web conversation page shows sub-agents (interim, until UI refresh B): one group per step of
`agent` calls with status, calls and duration, a read-only sub-agent view in the Inspector with
stop (`?subagent=<id>` opens one), a sub-agent's approvals and questions in the parent, and the
total tokens with sub-agents in the Context tab; trajectories link agent calls and parents both ways.

The agent page has a Sub-agents section (the agent tool, general-purpose, plugin templates from the
new `GET /agent-templates`, inline templates, allowlisted org agents with their warnings, and
"Can be used as a sub-agent by other agents"); the import review and catalog item list agent
templates; the purposes page explains the three sub-agent tiers; the admin console sets
per-organization sub-agent limits.
