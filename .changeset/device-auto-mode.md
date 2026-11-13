---
"@capybara-hq/device": minor
---

Auto mode: a device runs commands in one of two modes, `auto` (the default for a new login: as the
owner, with every command reviewed by the deployment) or `sandbox` (today's strict
`sandbox-runtime` profile). `capybara-device mode [auto|sandbox]` shows or switches it; `policy`
loses `set tier|isolation|localhost|remoteGrants` and keeps `show` and the allowlist commands;
`status` prints the mode. In auto mode file operations reach any absolute path on the machine. A
legacy `policy.json` (`isolation: none` or `tier: open`) migrates to auto, anything else to
sandbox, and `start` says so once. The policy op may only narrow to `sandbox`; a deployment may
never turn auto mode on.
