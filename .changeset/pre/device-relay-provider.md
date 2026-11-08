---
"@capybara-hq/kernel": patch
---

The `@device` sandbox provider: sandbox operations on a connected environment are relayed through
Redis to the gateway replica holding the machine's connection, waiting up to the operation's
deadline plus `environments.device.reconnectGraceSeconds`; registered on every role.
