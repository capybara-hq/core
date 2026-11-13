---
"@capybara-hq/capybara": minor
"@capybara-hq/kernel": minor
---

Auto mode for devices replaces the sandbox tiers. The platform's `devices.autoMode` switch and each
org's `autoMode` and `cloudNetwork` settings decide whether a device runs in auto mode (as the
owner, every command reviewed) or sandbox mode (the strict profile and the org's network allowlist).
The Platform tool and personal access tokens may only narrow auto mode and the cloud network, never
widen them. Device pages show each device's mode and network, and `POST /devices/:id/policy` stays
human-only: enabling auto mode happens only on the machine.
