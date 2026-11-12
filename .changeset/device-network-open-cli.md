---
"@capybara-hq/device": minor
---

`capybara-device policy set network open` turns off the device's own network limit (commands
reach what the organization allows) after printing the risk: it needs `--yes`, or an answer of `y`
on a terminal; without a terminal and without `--yes` it exits with status 2 and a hint.
`set network allowlist` is always accepted. `policy set remoteGrants owner|off` decides whether
the device owner may widen the network from the deployment.
