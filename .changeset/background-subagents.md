---
"@capybara-hq/kernel": minor
---

`Agent` dispatches sub-agents in the background: its result is immediate (the agentId), the parent
run goes on or ends while the child works, and a child's finish reaches its parent as a
`subagent_delivery` event (the final reply when it handed back nothing). `resume` is removed from
the `Agent` input (SendMessage replaces it). A run that ends no longer stops its background
children; only a forked skill's sub-agent still runs in the foreground. The wait sweep writes a
finish delivery its finisher never wrote.

Upgrade note: do not mix replicas across this change. A worker without it stops a finished run's
children (all of them are background children now) and reports a child's finish without the
delivery; stop every old worker before new ones take sub-agent jobs.
