---
"@capybara-hq/device": minor
---

Sandbox tiers in OS and Docker mode. A command runs at the device's tier (`policy set tier
strict|dev|open|default`) cut to the organization's ceiling: `dev` adds the dev hosts preset to
the network, package caches under `<dir>/cache/`, and on macOS local servers (unless a local
forwarding proxy is detected; `policy set localhost allow` overrides) and unix sockets under the
device's directories and a short socket directory that `TMPDIR` and `MAC_CHROMIUM_TMPDIR` point
at; `open` reaches anything the organization allows and needs `--yes`. A tier change reaches the
sandbox at the next command. Docker mode sizes `/dev/shm` per tier and opens the bridge only for
explicit local domains or tier `open`. `policy show` says what the tier gives on this machine, and
`start` prints a notice for a legacy `network: "open"`.
