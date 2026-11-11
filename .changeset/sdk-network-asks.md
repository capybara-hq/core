---
"@capybara-hq/plugin-sdk": minor
---

Network asks: `ExecResult.network` reports the hosts a command was refused and the layer that
refused them (`parseOpResult("exec")` keeps the valid entries, at most 20, and drops a malformed
report); the device hello may carry `features` and a local policy summary; a new device op `policy`
edits a device's allowed domains; exec args may carry run or task `grants`; `SandboxActor.runId`;
the `approval` card gains `scopeLabels` and the `skipped` state.
