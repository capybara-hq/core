---
"@capybara-hq/kernel": patch
---

Dormant (the activation gate stays off): once the permission context is activated, a run start's
project knowledge read is a set of kernel reads under the run's claim while it is queued, each
narrowed to the project root, its `AGENTS.md` and its `.agents/skills`; a person's `/project:<skill>`
renders a stub that tells the agent to load the skill with `Skill` instead of reading the device at
send time; the device project picker starts a stopped device for its owner before browsing it, and
answers `device.not_running` (409) when the instance stopped in between. Admission's working root
now falls back to the workspace exactly as the command review does (no usable project snapshot, a
root outside the reach or above the home). A refused background start keeps the kernel's reason in
the task, never the provider's message. With the gate off nothing changes.
