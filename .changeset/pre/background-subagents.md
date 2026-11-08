---
"@capybara-hq/kernel": minor
---

Background sub-agents (agent map spec `docs/superpowers/specs/2026-11-06-agent-map-design.md`).
`Agent` dispatches sub-agents in the background: its result is immediate (the agentId), the parent
run goes on or ends while the child works, and a child's finish reaches its parent as a
`subagent_delivery` event (the final reply when it handed back nothing). `resume` is removed from
the `Agent` input. A run that ends no longer stops its background children; only a forked skill's
sub-agent still runs in the foreground. The wait sweep writes a finish delivery its finisher never
wrote.

New builtin tools: `SendMessage` (`{ to, message }`) sends to one of the caller's own sub-agents
by agentId (absorbed by a running one at its next step; an idle one starts again with its context,
counted as a dispatch and run as the sender's trigger account) or, from a sub-agent, to `"parent"`
(a `note` delivery); `SubagentHandback` (`{ message }`, sub-agents only) delivers a report and the
sub-agent keeps its turn. Sub-agents may dispatch their own sub-agents down to `subagents.maxDepth`
levels below the root, each with its frozen `subagents` block. `subagent_delivery` is absorbable
like a message (`user_message.dispatch.kind` tells a parent's message from the task); full-run
replays feed recorded deliveries at their step, seed a sub-agent wake run from
`run_started.triggerSeq` and never dispatch, send or hand back, and logs written before this change
still rebuild with zero drift. The Claude Code tool map names `SendMessage` as a same-name tool.

Upgrade note: do not mix replicas across this change. A worker without it stops a finished run's
children (all of them are background children now) and reports a child's finish without the
delivery; stop every old worker before new ones take sub-agent jobs. A parent run left in a
(non-fork) `subagents` wait by the old version is resumed by the wait sweep (`sweepStuckRuns`,
after its grace period); a child still running then delivers its finish in the background, and one
that already finished under the old version gives its report as that `Agent` call's result, since
the old finisher wrote no delivery for it.
