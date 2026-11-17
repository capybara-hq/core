---
"@capybara-hq/device": minor
"@capybara-hq/plugin-sdk": minor
---

Replace the local policy's `mode` with a version-2 owner ceiling (`ownerCeiling: {fullAccess,
restrictedProjectReach}`): old `mode: auto` converts exactly to Full allowed with OS-user reach,
`mode: sandbox` to neither; `start` converts once under the policy lock and any write converts.
The strict reader only trusts a version-2 file. New `capybara-device ceiling show|set`: setting
needs both fields, narrowing applies directly, widening needs `--yes` or a confirmed prompt.
Stage authenticated owner reports for protocol 3: the `owner-report.json` sequence sidecar,
`parseOwnerCeilingReportV3`, and the report on policy frames, policy answers and applied policy
statuses; a staged `policy` op may only narrow the owner ceiling and reconciles live work before
answering. Protocol 2 and its `mode` summary are unchanged.
