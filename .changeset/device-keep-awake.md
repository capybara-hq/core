---
"@capybara-hq/device": minor
---

Keep-awake: `policy.json` gets `keepAwake` (`off`, `while-busy` default, `connected`). While it
applies, the program holds an idle-sleep assertion (`caffeinate` on macOS, `systemd-inhibit` on
Linux). New command `capybara-device keep-awake [show | off | while-busy | connected]`; the live
status adds `keepAwake` and `lastWakeAt`, and a wake from sleep is logged.
