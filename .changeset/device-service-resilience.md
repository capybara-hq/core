---
"@capybara-hq/device": patch
---

A restarted kernel or web no longer leaves the device offline until someone bootstraps the login
service by hand. The macOS launch agent now uses unconditional `KeepAlive` with a 30 s
`ThrottleInterval`, so a clean exit restarts the program instead of leaving the agent down. The
reconnect loop backs off exponentially with jitter, capped at 60 s, never gives up on a connection
failure, resets after a connection stays up, and reports each distinct failure once instead of
every attempt (the same failure at most once a minute). `capybara-device service install` boots an
existing agent out before writing the new plist and bootstraps it afterwards, so a reinstall picks
up the new file; `capybara-device service status` reports whether the agent is loaded and the
program running.
