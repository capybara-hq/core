---
"@capybara-hq/kernel": patch
---

Dormant (the activation gate stays off): once the permission context is activated, the kernel's
device callers outside the tools stop using the raw sandbox use. Adding a device project and its
suggestions go through the owner browse; the kernel's file read for `agents.register-skill` is a
managed operation of its tool call under the run's execution claim; and a background task launched
before activation is neither read, polled nor stopped by a raw command (its device waits for legacy
retirement, and reading a running one's output says so).
With the gate off nothing changes.
