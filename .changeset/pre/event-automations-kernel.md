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

Create and edit event automations: `trigger: { kind: "event", source, types, filter }` on the
automations API, the Platform operations and the `AutomationCreate` tool, checked against the org's
trigger sources (`automation.event_source_unavailable`, `automation.event_type_unknown`,
`automation.filter_invalid`; filters use filterable facts of the selected types with a value of the
fact's type). An event automation has no next run time and no time zone; mode `subject` needs an
event trigger and `chat` a time one (on PATCH too). `unattendedAsk` (`fail`, `wait` or null for the
org's default) is a field of create and update. New route `GET …/automations/event-sources` and
Platform operation `automations.event-sources` list the sources that serve the org with their event
declarations. Resuming a paused event automation no longer fails for lack of a next run time.

Fire event automations: an event run's message carries the `automationEvent` marker (the automation,
its run, the source and the coalesced events in order), rendered for the model as a block before the
prompt that says the events are reported by an extension and may have been written by other people
(at most 20 events per message: the first 5 and the latest 15, with a line counting the ones left
out, `omittedEvents` on the marker) (new drift reason `automation_event_block`, recorded as
`model_call.request.automationEventSeqs`). Mode `subject` keeps one conversation per subject: the
first run creates it with `conversations.subject` and maps it in `automation_conversations` (a
deleted or missing mapped conversation is replaced), later runs queue into it. Event runs skip the
overlap check in every mode (`new` gets a conversation per run, `conversation` and `subject` queue
into theirs), so no event is lost to an overlap skip. The run records `runs.trigger_event_id` (the
last event) beside `automation_run_id`, sub-agent and wake runs inherit both, `run_started.trigger`
is `automation_event`, and an automation's own `unattended_ask` overrides the org's default.
Conversation views list `subject`.

Event automations have no "run now" and no trial run: both are refused with the new error
`automation.run_now_unsupported` (409), and the web hides both actions on an event automation.
Their `expires_at` is enforced: the org's `defaultExpiryDays` applies to them too, the dispatcher
passes an expired one over and the scan ends it (`expired`). The skip reason `not_visible` is gone
(a subject the owner cannot see gets no delivery). The org setting `maxRunsPerHour` now counts per
person (the runs of the owner's automations), time automations included. A sub-agent of an
automation's own run counts as that run for the self-trigger guard (the root conversation's
agent). A trigger source whose `events()` fails or does not answer within `tools.timeoutMs` is
left out of the event sources and refuses an event trigger on it
(`automation.event_source_unavailable`). New platform config `automations.eventRetentionDays`
(default 30) and the `trigger-event-sweep` job (every five minutes): settled trigger events older
than the retention whose deliveries all have a run are deleted with their deliveries, and a
coalescing window whose job was lost for good gets a new one.
