---
"@capybara-hq/device": patch
---

macOS: a sandboxed command can no longer create, write, remove or rename into a path with a
component starting with the reserved staging prefix (`.capybara-staging-`, any case), matching the
shared SDK write policy the Linux broker enforces.
