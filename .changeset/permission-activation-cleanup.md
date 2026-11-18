---
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/design": patch
---

Kernel: the `device.auto_mode_not_allowed` refusal is gone with the protocol 2 machine-mode check
(a protocol 3 device's owner ceiling refuses with `device.full_access_not_allowed`). A device held
by the legacy retirement (`device.unavailable`, `device.restart_required`,
`device.recreate_required`, `device.replace_required`) now tells the model what clears it instead
of the inactive-provider text. Messages that named the removed `capybara-device mode` command name
`capybara-device ceiling set` instead.

`capybara-device`: unused protocol 2 helpers (the sandbox-runtime config, the network violation
parser, host file access) are removed. Design: the `KeycapCommand` example names
`capybara-device ceiling set`.
