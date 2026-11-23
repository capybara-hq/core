---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

A background start's reference names the provider's own instance generation (device-local's bound
machine generation), so the kernel no longer compares it with its own generation: it matches the
ref by operation id and handle id and pins the task to the generation it recorded. Every
background Bash on a device-local device was left unconfirmed ("its start was not confirmed; it is
being reconciled") and never settled; scheduled recovery now acknowledges those starts. A start
stopped before it was confirmed now ends `stopped` once the provider acknowledges its operation
revoke, instead of running until its retention expires (#765).
