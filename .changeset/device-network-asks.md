---
"@capybara-hq/device": minor
---

Accept owner-approved network changes from the deployment. `policy.json` gains `network`
(`allowlist` default, or `open`: commands reach what the organization allows) and `remoteGrants`
(`owner` default, or `off`: the device refuses every widening from the deployment). The new `policy`
operation adds or removes allowed domains and switches `network` (narrowing always accepted, every
host validated, written under the lock); a run's or task's granted hosts join a command's list
within the organization's egress. In OS mode exec results report the refused hosts; the hello
announces `networkReport` / `policyOp` and a summary of the local policy. The local command log
records each change from the deployment, refused attempts and each command's grants. A
Docker-mode device refuses widening from the deployment (it cannot limit single domains).
