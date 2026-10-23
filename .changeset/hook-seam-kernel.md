---
"@capybara-hq/kernel": minor
---

Close the hook / usage seam gaps found in the M7 segment 2 review. Compaction calls run the
`model.request` policy and observe hooks and `model.response`, and log their usage as a `usage` event
with `purpose: "compaction"` (reported through `usage.report`, counted in trajectory totals, skipped by
step consumers); a denied compaction fails through `compaction_failed` with a generic reason, the raw
detail in the audit row only. Policy hooks fail closed: a plugin that is enabled and approved and lists
the mount in `permissions.policyHooks` but is not loaded on a replica denies calls there (audit
`notLoaded`, throttled warning). `model.request` payloads carry media placeholders instead of bytes.
A `model.request` denial is sticky for the whole step across a resume. Without hooks, runs make no
extra lookups (sticky denials read from the loaded log; `usage.report` enqueue skipped without a local
handler). `usage.report` drops targets that are loaded without a handler or that no replica has loaded
(once, not on every attempt), drops unserved targets on the last attempt instead of failing, and caps
kept failed jobs at 100 000.
