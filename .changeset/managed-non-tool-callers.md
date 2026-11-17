---
"@capybara-hq/kernel": patch
---

Dormant (the activation gate stays off): once the permission context is activated, the kernel's
device callers outside the tools stop using the raw sandbox use. Device project listing, adding and
suggestions go through the owner browse; a run start's project knowledge read and the kernel's file
read for `agents.register-skill` are managed operations under the run's execution claim; a person's
project skill invocation is refused without a device call; and a background task launched before
activation is neither read nor stopped by a raw command (its device waits for legacy retirement).
With the gate off nothing changes.
