---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
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

Network asks decide on that intent. 「这台设备一直允许」 records the intent (naming the ask) before
the device is called, and the ask's decision and the op's outcome are written in one transaction;
a change applied after the ask closed is audited `device.network_allowed` with `late: true` in that
same transaction. When the process stops between the call and the record, the resolve job approves
the still-pending ask (`always`, by the person who chose it) and resumes its run if the device
applied the change; otherwise the ask stays pending with the reason (`detail.attempt`, an
`approval_updated` event) and the card says why. A device is asked only when its program announces
`policyOpId`. The device page lists changes the machine did not confirm or that did not take
effect (the view's `confirmed` is replaced by `outcome`).
