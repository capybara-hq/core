---
"@capybara-hq/capybara": minor
---

Auto mode: a device runs in `auto` (commands with the environment's own capability, guarded by
command review) or `sandbox`. The platform's `devices.autoMode` switch and the org's `autoMode` and
`cloudNetwork` settings replace the sandbox tiers and the org egress setting; `/admin/settings`
shows the platform's switch with where it comes from, `/settings/sandbox` holds the org's auto mode
and the cloud devices' sandbox-mode network, and a device page shows its mode, the 自动 / 沙箱
switch and its network (sandbox mode only). A command the review holds appears as its own approval
card in the conversation and in the inbox.
