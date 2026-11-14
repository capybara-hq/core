---
"@capybara-hq/device": minor
---

Auto mode: a device runs commands in one of two modes, `auto` (the default for a new login when the
organization allows it: as the owner, with every command reviewed by the deployment; a fresh login
in an auto-forbidden organization writes sandbox mode) or `sandbox` (today's strict
`sandbox-runtime` profile). `capybara-device mode [auto|sandbox]` shows or switches it; `policy`
loses `set tier|isolation|localhost|remoteGrants` and keeps `show` and the allowlist commands;
`status` prints the mode. In auto mode file operations reach any absolute path on the machine. A
legacy `policy.json` (`isolation: none` or `tier: open`) migrates to auto, anything else to
sandbox, and `start` says so once. The policy op may only narrow to `sandbox`; a deployment may
never turn auto mode on. When the OS sandbox is unavailable the device still serves auto mode, and
sandbox mode refuses every command with the reason (and refuses the `mode sandbox` switch) instead
of running unsandboxed.
