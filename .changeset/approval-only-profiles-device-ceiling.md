---
"@capybara-hq/device": patch
---

The device's owner ceiling now describes the sandbox for every profile: `outsideSandbox` (whether
one approved call may run outside the sandbox), `network` (`open` public internet or the
`allowedDomains` allowlist) and the project reach. Full access no longer means no sandbox: an
ordinary Full access call gets scoped roots and the denied read roots like the other profiles, and
only an escalated call runs outside the sandbox, within `outsideSandbox`. A new install gets
`outsideSandbox: false` with the open network. `policy.json` moves to version 3 and an old file is
converted once, never wider (Full access allowed becomes outside the sandbox with the open network;
denied keeps the allowlist, and `start` prints `capybara-device ceiling set --network open`). The
CLI is `capybara-device ceiling set --outside-sandbox on|off --network open|allowlist
[--project-reach workspace|os-user]`; `--full-access` is gone. The wire stays device protocol 3
until the protocol 4 cutover.
