---
"@capybara-hq/kernel": patch
---

Channels: a connection's last error is cleared once the connection has held for a lease period, so
a failure it recovered from (such as a network error while it first connected) no longer stays on
its page next to "running".
