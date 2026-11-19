---
"@capybara-hq/kernel": patch
---

Permission context version 2: the recorded context carries the device `sandbox` block, Full access
may record a scoped sandbox, the model text states the sandbox once and then who approves each
crossing kind (the escalation clause only where escalation is available), request metadata names
the sandbox block it saw, and step and full-run replays report `device_sandbox_changed` when the
snapshot rebuilds another block than the recorded one (a sandbox change between runs is zero drift).
Stored v1 contexts are read as v2 with no sandbox block, so existing conversations and eval cases keep
working.
