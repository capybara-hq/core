---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

Add the observe hook `run.lifecycle` (`RunLifecyclePayload`, `RunLifecycleDeclineReason`;
collaboration spec §4.8). The plugin named by a conversation's subject hears, durably and at least
once, each phase of the conversation's runs: `started`, `waiting` (on a person: `waitingOn`
`approval` or `input`), `resumed` (that wait cleared and the run continues), `finished`, `failed`
and `aborted`; compact runs are never reported. A directed event's source plugin hears
`offer_declined` when the work was not run, with a `reason`: `off` (the person's rule),
`declined` (the person declined the offer), `paused` (their acceptance automation is paused),
`expired` (the offer stayed unanswered for seven days) or `undelivered` (the kernel gave up
routing the event). Only a plugin that declares the hook in `permissions.hooks` and is enabled in
the org is told, checked when the change commits and again at delivery.
