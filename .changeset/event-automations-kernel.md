---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/plugin-tools": patch
---

Add the event automation tables and columns (migration 0189): trigger events, event deliveries,
one conversation per subject, the `subject` mode, and runs keyed by `trigger_key`.

Serve `ctx.triggers.emit`: the kernel validates the event against the approved
`permissions.triggers.emit`, verifies its cause (a pipeline-made tool call context of a run in the
event's org, which sets the chain depth, or an active member), stores one `trigger_events` row per
(org, plugin, dedupe key) and owes a `trigger-dispatch` job through the outbox. The review shows
the declared event types as a group of their own (`permissions.triggers:<type>`, blocking, not
sensitive). `@capybara-hq/testing` adds the `fake-trigger-source` fixture; `capybara-plugin check`
reports `perm-triggers` when `ctx.triggers` is used without `permissions.triggers`.

Dispatch and coalesce event automations: a stored event fires the org's active event automations
on its source and type whose filter matches (filterable facts only), except the cause run's own
owner and agent, for the owners the source's `visible()` admits. Events of one (automation,
subject) within `automations.coalesceSeconds` become one run keyed by the first event; past
`maxEventRunsPerSubjectPerHour` the run is skipped with `subject_rate`; past `maxEventDepth` the
event is `depth_stopped`; a source in `eventSourcesOff` or one not serving the org leaves it
`undelivered`. New org settings `maxEventDepth`, `coalesceSeconds`,
`maxEventRunsPerSubjectPerHour`, `eventSourcesOff`, clamped by the kernel config caps
`automations.maxEventDepthCap`, `coalesceSecondsCap`, `maxEventRunsPerSubjectPerHourCap`.
