---
"@capybara-hq/kernel": patch
---

A staged (protocol 3) device request held under an operation identity that the gateway refused
because the machine's connection changed before it was sent is now a definite pre-effect failure
(`DeviceRequestNotSentError`, a scope refusal), never an unknown outcome: the operation is recorded
as failed, a background start settles as not started, and a retry of the same call keeps the same
operation identity without an unknown outcome. A recovery whose own request was not sent keeps the
start unknown and tries again later, since it proves nothing about the first dispatch.
