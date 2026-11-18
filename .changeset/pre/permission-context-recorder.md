---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Add the dormant recorder of the model-facing permission context: one authority projection shared with operation admission (`SandboxOperationAuthority.readContextLocked`, no call, grant expansion or provider effect), an applied-environment reader over the installed local instance binding and its current runtime attestation, and `PermissionContextRecorder`, which appends a `permission_context` snapshot only when the persisted log's latest one differs, under the ordered authority locks and the run's execution claim. Its failures are named run errors (`run.permission_context_*`, with zh and en copy); it refuses replay conversations. Nothing in production calls it until the request boundary and the managed tool path activate together.
