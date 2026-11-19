---
"@capybara-hq/device": patch
---

A restricted macOS command sends private, link-local and loopback destinations to the operation's
proxy too (the sandbox runtime's `NO_PROXY` is unset inside the sandbox), so a LAN request gets the
proxy's 403 instead of a bare "Couldn't connect to server" from a connect Seatbelt refused.
