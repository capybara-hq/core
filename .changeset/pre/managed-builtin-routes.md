---
"@capybara-hq/kernel": patch
---

Builtin tools are ready for the permission activation: once the one activation gate is on, Read,
Write, Edit, Glob, Grep, Deliver, foreground and background Bash, FetchAttachment and Skill enter
their device only on the managed route, recording the marked device paths before their callback
and running every provider call as a managed operation (a background command through the managed
launch). Every reviewed call carries the root it was judged against, the workspace included, and
fails as stale before anything runs when the held device context names another root. A refused
Full access (off by policy, or above the device owner's ceiling), an operation outside the admitted
scope, a profile the device cannot enforce and an operation of unknown outcome are actionable tool
errors in the kernel's own words, never the provider's. Managed operation results holding a NUL
or a lone surrogate (Glob and Grep output) are retained in chunks instead of failing in jsonb.
With the gate off nothing changes.
