---
"@capybara-hq/device": minor
---

A running `capybara-device` answers on a local control socket (`<stateDir>/control.sock`, mode
0600): live status, running operations, status events, drain and stop. `status --json` adds
`control` and `live`.
