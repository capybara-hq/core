---
"@capybara-hq/kernel": minor
---

Auto mode for devices replaces the sandbox tiers: the platform's `devices.autoMode` switch and each
org's `autoMode` and `cloudNetwork` settings decide whether a device runs in auto mode (as the
owner, every command reviewed) or sandbox mode (the OS sandbox and the org's network allowlist).
Every `Bash` command and every write outside the workspace now passes a kernel command review (rules
plus a classifier, purpose `review`) that allows, asks (an approval of kind `command`) or denies,
and fails closed; an unattended run never waits for one. The Platform tool and personal access
tokens may only narrow auto mode and the cloud network, never widen them, and
`POST /devices/:id/policy` stays human-only and may only narrow to `sandbox`. New errors
`sandbox.open_network_refused`, `device.auto_mode_not_allowed` and `device.mode_on_device`;
`sandbox.tier_refused` is gone.
