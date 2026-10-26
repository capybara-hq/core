---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
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
