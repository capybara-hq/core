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
