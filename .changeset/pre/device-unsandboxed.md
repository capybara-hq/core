---
"@capybara-hq/device": minor
---

A device in OS mode runs commands without a sandbox when its owner sets it on the machine
(`capybara-device policy set isolation none`, with tier `open`; the risk text is shown and needs
`--yes` or a `y` at the prompt). Below tier `open`, or when the deployment does not allow the
command to run unsandboxed (`limits.allowUnsandboxed` not `true`), such a device refuses commands,
naming why; a command whose sandbox is turned back on while it starts is refused too, and an
invalid `policy.json` turns the sandbox back on. The
deployment can never turn the sandbox off: the `policy` op accepts only `isolation: "sandbox"`, and
a higher tier only under `remoteGrants: "owner"`. The hello announces the `tiers` feature, the
policy summary reports the tier the device runs at, and the local command log records each
command's tier and isolation.
