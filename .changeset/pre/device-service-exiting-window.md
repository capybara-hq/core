---
"@capybara-hq/device": patch
---

A device service that removed its socket and is still exiting no longer fails requests with
`connect ENOENT`: an ensure or request waits (bounded) for the old process to exit, starts the
service again and waits for its socket.
