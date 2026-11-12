---
"@capybara-hq/kernel": minor
---

Device policy changes record their intent before the call. Before a `policy` op is sent, one
transaction writes the op on the machine's row (who asked, for which network ask), audits
`device.policy_requested` and owes a `device-op-resolve` job for when the op can no longer reach the
machine; the outcome is recorded after the call: `device.policy_changed` when applied,
`device.policy_failed` when refused or never received, `device.policy_unknown` when no answer came.
A crash between the call and the record no longer leaves a changed device without an audit: the
job asks the machine what became of the op (`policyStatus`, never sending the change again), and
a machine that is offline reports it in its next hello (`recentOps`), recorded late. Policy changes
now need a `capybara-device` that announces `policyOpId`; an older one is told to update.
`device.policy_changed` no longer carries `confirmed`.
