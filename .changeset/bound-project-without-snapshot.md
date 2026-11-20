---
"@capybara-hq/capybara": patch
---

A conversation bound to a project works in the project's root even before a run start recorded a
snapshot (the device was offline or the read timed out); only a recorded unavailable snapshot moves
it to the device's workspace.
